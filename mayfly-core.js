// mayfly-core.ts — Mayfly Chat protocol client for the Pi `mayfly` extension.
// Zero deps (node:crypto + global fetch). Implements https://mayfly.chat/docs/protocol.md.
// sealMessage/openEvent and the validation helpers are adapted from Mayfly's reference client
// (srv/static/client.mjs, MIT); see THIRD_PARTY_NOTICES.md.
//
// Owns: crypto, transport, the cursor, dedup, "skip our own `from`", 409 handling.
// Does NOT own: Pi wiring, AbortControllers for the session, UI. See index.ts.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
/** Unrecoverable: channel gone (404) or wrong key (401). Stop watching. */
export class MayflyFatalError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.name = "MayflyFatalError";
        this.status = status;
    }
}
class HttpError extends Error {
    status;
    body;
    constructor(status, body) {
        super(`HTTP ${status}${body?.error ? `: ${body.error}` : ""}`);
        this.status = status;
        this.body = body;
    }
}
const WATCH_WAIT = 50; // seconds per long poll
const MAX_BACKOFF_MS = 30_000;
const b64 = (b) => Buffer.from(b).toString("base64url");
function unb64(text) {
    if (typeof text !== "string" || !/^[A-Za-z0-9_-]*={0,2}$/.test(text))
        throw new Error("invalid base64url");
    return Buffer.from(text, "base64url");
}
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const ws = "[\\p{White_Space}\\x1c-\\x1f]";
const untrimmed = new RegExp(`^${ws}|${ws}$`, "u");
const blank = new RegExp(`^${ws}*$`, "u");
const validText = (s) => typeof s === "string" && !/\p{Cs}/u.test(s);
export const validName = (s) => validText(s) && s !== "" && !untrimmed.test(s) && !/\p{Cc}/u.test(s);
function sleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted)
            return resolve();
        const t = setTimeout(done, ms);
        function done() {
            clearTimeout(t);
            signal?.removeEventListener("abort", done);
            resolve();
        }
        signal?.addEventListener("abort", done, { once: true });
    });
}
/** HKDF-SHA256 (empty salt) derivations from the 32-byte URL key, per protocol.md. */
export function deriveKeys(key) {
    if (key.length !== 32)
        throw new Error("URL #key must decode to 32 bytes");
    const derive = (info, n) => Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), info, n));
    return { id: b64(derive("mayfly id", 16)), auth: b64(derive("mayfly auth", 32)), enc: derive("mayfly enc", 32) };
}
/** Seal `{from,text}` for sequence `seq`: JSON, space-padded to 256n bytes, AES-256-GCM, AAD "id:seq". */
export function sealMessage(keys, seq, message, nonce = randomBytes(12)) {
    const plain = Buffer.from(JSON.stringify(message), "utf8");
    const padded = Buffer.alloc(Math.ceil(plain.length / 256) * 256, 0x20);
    plain.copy(padded);
    const c = createCipheriv("aes-256-gcm", keys.enc, nonce).setAAD(Buffer.from(`${keys.id}:${seq}`));
    const ct = Buffer.concat([c.update(padded), c.final(), c.getAuthTag()]);
    return { nonce: b64(nonce), ct: b64(ct) };
}
/** Decrypt one server event. Failures become placeholder rows at their original seq (never skipped). */
export function openEvent(keys, ev) {
    const row = { seq: ev.seq, ts: ev.ts, src: ev.src, from: "", text: "(undecryptable message)" };
    try {
        const nonce = unb64(ev.nonce);
        if (nonce.length !== 12)
            return row;
        const ct = unb64(ev.ct);
        if (ct.length < 16)
            return row;
        const d = createDecipheriv("aes-256-gcm", keys.enc, nonce).setAAD(Buffer.from(`${keys.id}:${ev.seq}`));
        d.setAuthTag(ct.subarray(ct.length - 16));
        const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
        row.text = "(invalid message)";
        const inner = JSON.parse(utf8.decode(plain));
        if (inner && typeof inner === "object" && !Array.isArray(inner) && validName(inner.from) && validText(inner.text)) {
            row.from = inner.from;
            row.text = inner.text;
        }
    }
    catch { }
    return row;
}
/**
 * Parse the `/stop <name|all> [reason]` chat convention (handled by the watcher, not the model).
 * A name with spaces must be double-quoted: `/stop "Pi Bot" reason`. Returns null for anything else.
 */
export function parseStop(text) {
    const m = /^\/stop\s+(?:@?"([^"]+)"|@?(\S+))(?:\s+([\s\S]*\S))?\s*$/i.exec(text);
    return m ? { target: m[1] ?? m[2], reason: m[3] } : null;
}
export function openChannel(url, name) {
    if (!validName(name))
        throw new Error("name must be nonempty, trimmed, no control characters");
    const m = /^(https?:\/\/[^\s\\/?#@\x00-\x1f]+)(\/[^\s\\?#\x00-\x1f]*)#(.+)$/i.exec(
    // Slash-command args aren't shell-parsed: tolerate surrounding quotes/angle brackets.
    url.trim().replace(/^['"<`]+|['">`]+$/g, ""));
    if (!m)
        throw new Error("expected a full Mayfly URL: https://host/c/ID#key");
    const [, origin, path, frag] = m;
    const keys = deriveKeys(unb64(frag));
    const { id, auth } = keys;
    if (path !== `/c/${id}`)
        throw new Error("URL path does not match its #key");
    const closer = new AbortController();
    let delivered = -1; // highest seq handed to the model
    let head = -1; // highest seq known to exist (cursor for posting)
    let primed = false; // has the initial cursor been established?
    const mine = new Set(); // seqs we posted (bounded; oldest pruned)
    const OWN_MAX = 2000;
    function addMine(seq) {
        mine.add(seq);
        if (mine.size > OWN_MAX)
            mine.delete(mine.values().next().value);
    }
    const seal = (seq, message) => sealMessage(keys, seq, message);
    const open = (ev) => openEvent(keys, ev);
    async function request(method, query, body, signal) {
        const signals = [closer.signal];
        if (signal)
            signals.push(signal);
        let res;
        res = await fetch(`${origin}/c/${id}/events?${query}`, {
            method,
            headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
            body: body ? JSON.stringify(body) : undefined,
            redirect: "manual",
            signal: AbortSignal.any(signals),
        });
        const raw = await res.text();
        let json;
        try {
            json = JSON.parse(raw);
        }
        catch {
            json = { error: raw.slice(0, 200) };
        }
        if (res.status === 401)
            throw new MayflyFatalError(401, "unauthorized: wrong channel key");
        if (res.status === 404)
            throw new MayflyFatalError(404, "channel not found (deleted or expired)");
        if (res.status !== 200 && res.status !== 409)
            throw new HttpError(res.status, json);
        if (!Array.isArray(json?.events))
            throw new HttpError(res.status, { error: "reply has no events list" });
        return { status: res.status, json };
    }
    /** Track head, dedup against delivered, drop our own. Returns messages to deliver. */
    function ingest(events, lastFromServer) {
        if (typeof lastFromServer === "number" && lastFromServer > head)
            head = lastFromServer;
        const out = [];
        for (const ev of events) {
            if (typeof ev?.seq !== "number")
                continue;
            if (ev.seq > head)
                head = ev.seq;
            if (ev.seq <= delivered)
                continue;
            delivered = ev.seq;
            const msg = open(ev);
            if (msg.from === channel.name)
                continue;
            out.push(msg);
        }
        return out;
    }
    /** Read pages since `since` until more=false (no wait). */
    async function drain(since, signal) {
        const all = [];
        let last = since;
        for (;;) {
            const { json } = await request("GET", `since=${last}&wait=0`, undefined, signal);
            all.push(...json.events);
            last = json.last;
            if (!json.more)
                return { events: all, last };
        }
    }
    async function prime(fromStart, signal, since) {
        if (primed)
            return;
        if (fromStart) {
            primed = true;
            return;
        }
        if (typeof since === "number" && Number.isInteger(since) && since >= -1) {
            delivered = Math.max(delivered, since);
            head = Math.max(head, since);
            primed = true;
            return;
        }
        // Start at the current head: don't replay history as "new".
        const { last } = await drain(-1, signal);
        if (!primed) {
            head = Math.max(head, last);
            delivered = Math.max(delivered, last);
            primed = true;
        }
    }
    async function postRaw(text) {
        if (!validText(text) || blank.test(text))
            throw new Error("message must be nonblank text");
        await prime(false);
        const cursor = head;
        let attempted = false;
        try {
            attempted = true;
            const { status, json } = await request("POST", `last=${cursor}&wait=0`, seal(cursor + 1, { from: channel.name, text }));
            if (status === 409) {
                // Missed page; may have more. Read the rest, deliver everything, let the model reconsider.
                let events = json.events;
                let last = json.last;
                if (json.more) {
                    const rest = await drain(last);
                    events = events.concat(rest.events);
                    last = rest.last;
                }
                return { posted: false, conflict: true, newMessages: ingest(events, last) };
            }
            // Our own post is seq=json.id; mark it known. Events are replies after it.
            if (typeof json.id === "number" && json.id > head)
                head = json.id;
            if (typeof json.id === "number")
                addMine(json.id);
            return { posted: true, id: json.id, newMessages: ingest(json.events, json.last) };
        }
        catch (e) {
            if (e instanceof MayflyFatalError)
                throw e;
            if (e instanceof HttpError && e.status === 503 && e.body?.posted === false)
                return { posted: false, error: "server restarting; try again shortly", newMessages: [] };
            if (e instanceof HttpError && (e.status === 400 || e.status === 413 || e.status === 429))
                return { posted: false, error: e.message, newMessages: [] };
            return {
                posted: attempted ? null : false,
                error: `${e?.message ?? e} — post may have succeeded; read history before reposting`,
                newMessages: [],
            };
        }
    }
    const channel = {
        id,
        redactedUrl: `${origin}/c/${id}`,
        name,
        get last() {
            return delivered;
        },
        ownSeqs: mine,
        post(text, opts) {
            const prefix = opts?.replyTo !== undefined ? `/re ${opts.replyTo} ` : "";
            return postRaw(prefix + text);
        },
        react(seq, emoji) {
            return postRaw(`/react ${seq} ${emoji}`);
        },
        async history(n) {
            const count = Math.max(1, Math.floor(n));
            // Find head cheaply, then read the tail window.
            const probe = await request("GET", `since=${Number.MAX_SAFE_INTEGER}&wait=0`);
            const top = probe.json.last;
            if (top > head)
                head = top;
            const { events } = await drain(Math.max(-1, top - count));
            const msgs = events.map(open);
            for (const m of msgs)
                if (m.from === channel.name)
                    addMine(m.seq);
            return msgs;
        },
        async watch(onBatch, signal, opts) {
            let backoff = 1000;
            while (!signal.aborted && !closer.signal.aborted) {
                try {
                    await prime(!!opts?.fromStart, signal, opts?.since);
                    const { json } = await request("GET", `since=${delivered}&wait=${WATCH_WAIT}`, undefined, signal);
                    backoff = 1000;
                    const msgs = ingest(json.events, json.last);
                    if (msgs.length && !signal.aborted)
                        onBatch(msgs);
                    // If more pages are pending, the next loop iteration fetches them immediately.
                }
                catch (e) {
                    if (signal.aborted || closer.signal.aborted)
                        return;
                    if (e instanceof MayflyFatalError)
                        throw e;
                    opts?.onError?.(e, backoff);
                    await sleep(backoff, signal);
                    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
                }
            }
        },
        close() {
            closer.abort();
        },
    };
    return channel;
}
/** Compact plain-text rendering for injecting into the model's context. */
export function formatMessages(msgs) {
    return msgs.map((m) => `[#${m.seq} ${m.from || "?"}] ${m.text.replace(/\s+$/, "")}`).join("\n");
}
/** Validate a bare http(s) origin (no path, query, or fragment). */
function parseOrigin(origin) {
    let u;
    try {
        u = new URL(origin.trim().replace(/^['"<`]+|['">`]+$/g, ""));
    }
    catch {
        throw new Error("expected an http(s) origin such as https://mayfly.chat");
    }
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== ""))
        throw new Error("expected an http(s) origin with no path, query, or fragment, such as https://mayfly.chat");
    return u;
}
/**
 * Create a new empty channel (protocol.md "POST /new"): 32 random key bytes, derive id/auth, send
 * {id, auth_hash: b64url(sha256(auth))}, expect 303. The key never leaves this process.
 */
export async function createChannel(origin = "https://mayfly.chat", signal) {
    const u = parseOrigin(origin);
    const key = randomBytes(32);
    const { id, auth } = deriveKeys(key);
    const body = JSON.stringify({ id, auth_hash: b64(createHash("sha256").update(auth, "utf8").digest()) });
    const res = await fetch(new URL("/new", u), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        redirect: "manual",
        signal: signal ?? AbortSignal.timeout(60_000),
    });
    const raw = await res.text().catch(() => "");
    if (res.status !== 303) {
        let detail = raw.slice(0, 200).trim();
        try {
            detail = JSON.parse(raw)?.error ?? detail;
        }
        catch { }
        if (res.status === 429)
            throw new Error("channel creation rate limit reached on this server; try again later");
        throw new Error(`channel creation failed: HTTP ${res.status}${detail ? ` (${detail})` : ""}`);
    }
    const redactedUrl = `${u.origin}/c/${id}`;
    return { url: `${redactedUrl}#${b64(key)}`, redactedUrl, id };
}
/** Permanently delete a channel (DELETE /c/ID with the derived bearer). Used by tests; not exposed as a tool. */
export async function deleteChannel(url) {
    const m = /^(https?:\/\/[^\s\\/?#@\x00-\x1f]+)\/c\/([A-Za-z0-9_-]+)#(.+)$/i.exec(url.trim());
    if (!m)
        throw new Error("expected a full Mayfly URL: https://host/c/ID#key");
    const keys = deriveKeys(unb64(m[3]));
    if (keys.id !== m[2])
        throw new Error("URL path does not match its #key");
    const res = await fetch(`${m[1]}/c/${keys.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${keys.auth}` } });
    if (res.status !== 204)
        throw new Error(`delete failed: HTTP ${res.status}`);
}
