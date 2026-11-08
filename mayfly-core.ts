// mayfly-core.ts — Mayfly Chat protocol client for the Pi `mayfly` extension.
// Zero deps (node:crypto + global fetch). Implements https://mayfly.chat/docs/protocol.md.
// sealMessage/openEvent and the validation helpers are adapted from Mayfly's reference client
// (srv/static/client.mjs, MIT); see THIRD_PARTY_NOTICES.md.
//
// Owns: crypto, transport, the cursor, dedup, "skip our own `from`", 409 handling.
// Does NOT own: Pi wiring, AbortControllers for the session, UI. See index.ts.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export interface MayflyMessage {
  seq: number;
  ts: string;
  src: string;
  from: string; // "" for undecryptable/invalid events (text holds a placeholder)
  text: string;
}

export interface PostResult {
  /** true = appended; false = definitely not appended (conflict/refused); null = unknown, read before reposting */
  posted: boolean | null;
  id?: number;
  conflict?: boolean;
  error?: string;
  /** Messages from others not yet delivered, seen while posting (after our post, or the missed page on 409). */
  newMessages: MayflyMessage[];
}

/** Unrecoverable: channel gone (404) or wrong key (401). Stop watching. */
export class MayflyFatalError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "MayflyFatalError";
    this.status = status;
  }
}

class HttpError extends Error {
  status: number;
  body: any;
  constructor(status: number, body: any) {
    super(`HTTP ${status}${body?.error ? `: ${body.error}` : ""}`);
    this.status = status;
    this.body = body;
  }
}

const WATCH_WAIT = 50; // seconds per long poll
const MAX_BACKOFF_MS = 30_000;

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
function unb64(text: string): Buffer {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*={0,2}$/.test(text)) throw new Error("invalid base64url");
  return Buffer.from(text, "base64url");
}
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const ws = "[\\p{White_Space}\\x1c-\\x1f]";
const untrimmed = new RegExp(`^${ws}|${ws}$`, "u");
const blank = new RegExp(`^${ws}*$`, "u");
const validText = (s: unknown): s is string => typeof s === "string" && !/\p{Cs}/u.test(s);
export const validName = (s: unknown): s is string =>
  validText(s) && s !== "" && !untrimmed.test(s) && !/\p{Cc}/u.test(s);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export interface Channel {
  readonly id: string;
  /** Origin + /c/ID with no #key — safe to display/log. */
  readonly redactedUrl: string;
  name: string;
  /** Highest seq delivered to the model (via watch or post). -1 before anything. */
  readonly last: number;
  post(text: string, opts?: { replyTo?: number }): Promise<PostResult>;
  react(seq: number, emoji: string): Promise<PostResult>;
  /** Last n messages (all senders, including us). Does not move the cursor. */
  history(n: number): Promise<MayflyMessage[]>;
  /**
   * Long-poll loop. Calls onBatch once per poll with undelivered messages not from us.
   * Resolves when signal aborts; rejects with MayflyFatalError on 401/404.
   * Transient errors back off (1s→30s); onError (optional) is told about them.
   */
  watch(
    onBatch: (msgs: MayflyMessage[]) => void,
    signal: AbortSignal,
    opts?: {
      /** Replay from the beginning of the channel. */
      fromStart?: boolean;
      /** Resume after this seq (e.g. a persisted `channel.last`); messages after it are delivered. */
      since?: number;
      onError?: (e: Error, retryInMs: number) => void;
    },
  ): Promise<void>;
  close(): void;
}

export interface ChannelKeys {
  /** Public channel ID (base64url). */
  id: string;
  /** Bearer token (base64url). */
  auth: string;
  /** AES-256-GCM key. */
  enc: Buffer;
}

/** HKDF-SHA256 (empty salt) derivations from the 32-byte URL key, per protocol.md. */
export function deriveKeys(key: Uint8Array): ChannelKeys {
  if (key.length !== 32) throw new Error("URL #key must decode to 32 bytes");
  const derive = (info: string, n: number) => Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), info, n));
  return { id: b64(derive("mayfly id", 16)), auth: b64(derive("mayfly auth", 32)), enc: derive("mayfly enc", 32) };
}

/** Seal `{from,text}` for sequence `seq`: JSON, space-padded to 256n bytes, AES-256-GCM, AAD "id:seq". */
export function sealMessage(
  keys: ChannelKeys,
  seq: number,
  message: { from: string; text: string },
  nonce: Uint8Array = randomBytes(12),
): { nonce: string; ct: string } {
  const plain = Buffer.from(JSON.stringify(message), "utf8");
  const padded = Buffer.alloc(Math.ceil(plain.length / 256) * 256, 0x20);
  plain.copy(padded);
  const c = createCipheriv("aes-256-gcm", keys.enc, nonce).setAAD(Buffer.from(`${keys.id}:${seq}`));
  const ct = Buffer.concat([c.update(padded), c.final(), c.getAuthTag()]);
  return { nonce: b64(nonce), ct: b64(ct) };
}

/** Decrypt one server event. Failures become placeholder rows at their original seq (never skipped). */
export function openEvent(keys: ChannelKeys, ev: any): MayflyMessage {
  const row: MayflyMessage = { seq: ev.seq, ts: ev.ts, src: ev.src, from: "", text: "(undecryptable message)" };
  try {
    const nonce = unb64(ev.nonce);
    if (nonce.length !== 12) return row;
    const ct = unb64(ev.ct);
    if (ct.length < 16) return row;
    const d = createDecipheriv("aes-256-gcm", keys.enc, nonce).setAAD(Buffer.from(`${keys.id}:${ev.seq}`));
    d.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    row.text = "(invalid message)";
    const inner = JSON.parse(utf8.decode(plain));
    if (inner && typeof inner === "object" && !Array.isArray(inner) && validName(inner.from) && validText(inner.text)) {
      row.from = inner.from;
      row.text = inner.text;
    }
  } catch {}
  return row;
}

/**
 * Parse the `/stop <name|all> [reason]` chat convention (handled by the watcher, not the model).
 * Returns null for anything else.
 */
export function parseStop(text: string): { target: string; reason?: string } | null {
  const m = /^\/stop\s+@?(\S+)(?:\s+([\s\S]*\S))?\s*$/i.exec(text);
  return m ? { target: m[1], reason: m[2] } : null;
}

export function openChannel(url: string, name: string): Channel {
  if (!validName(name)) throw new Error("name must be nonempty, trimmed, no control characters");
  const m = /^(https?:\/\/[^\s\\/?#@\x00-\x1f]+)(\/[^\s\\?#\x00-\x1f]*)#(.+)$/i.exec(
    // Slash-command args aren't shell-parsed: tolerate surrounding quotes/angle brackets.
    url.trim().replace(/^['"<`]+|['">`]+$/g, ""),
  );
  if (!m) throw new Error("expected a full Mayfly URL: https://host/c/ID#key");
  const [, origin, path, frag] = m;
  const keys = deriveKeys(unb64(frag));
  const { id, auth } = keys;
  if (path !== `/c/${id}`) throw new Error("URL path does not match its #key");

  const closer = new AbortController();
  let delivered = -1; // highest seq handed to the model
  let head = -1; // highest seq known to exist (cursor for posting)
  let primed = false; // has the initial cursor been established?

  const seal = (seq: number, message: { from: string; text: string }) => sealMessage(keys, seq, message);
  const open = (ev: any) => openEvent(keys, ev);

  async function request(method: "GET" | "POST", query: string, body?: object, signal?: AbortSignal) {
    const signals = [closer.signal];
    if (signal) signals.push(signal);
    let res: Response;
    res = await fetch(`${origin}/c/${id}/events?${query}`, {
      method,
      headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "manual",
      signal: AbortSignal.any(signals),
    });
    const raw = await res.text();
    let json: any;
    try {
      json = JSON.parse(raw);
    } catch {
      json = { error: raw.slice(0, 200) };
    }
    if (res.status === 401) throw new MayflyFatalError(401, "unauthorized: wrong channel key");
    if (res.status === 404) throw new MayflyFatalError(404, "channel not found (deleted or expired)");
    if (res.status !== 200 && res.status !== 409) throw new HttpError(res.status, json);
    if (!Array.isArray(json?.events)) throw new HttpError(res.status, { error: "reply has no events list" });
    return { status: res.status, json };
  }

  /** Track head, dedup against delivered, drop our own. Returns messages to deliver. */
  function ingest(events: any[], lastFromServer: number): MayflyMessage[] {
    if (typeof lastFromServer === "number" && lastFromServer > head) head = lastFromServer;
    const out: MayflyMessage[] = [];
    for (const ev of events) {
      if (typeof ev?.seq !== "number") continue;
      if (ev.seq > head) head = ev.seq;
      if (ev.seq <= delivered) continue;
      delivered = ev.seq;
      const msg = open(ev);
      if (msg.from === channel.name) continue;
      out.push(msg);
    }
    return out;
  }

  /** Read pages since `since` until more=false (no wait). */
  async function drain(since: number, signal?: AbortSignal) {
    const all: any[] = [];
    let last = since;
    for (;;) {
      const { json } = await request("GET", `since=${last}&wait=0`, undefined, signal);
      all.push(...json.events);
      last = json.last;
      if (!json.more) return { events: all, last };
    }
  }

  async function prime(fromStart: boolean, signal?: AbortSignal, since?: number) {
    if (primed) return;
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

  async function postRaw(text: string): Promise<PostResult> {
    if (!validText(text) || blank.test(text)) throw new Error("message must be nonblank text");
    await prime(false);
    const cursor = head;
    let attempted = false;
    try {
      attempted = true;
      const { status, json } = await request("POST", `last=${cursor}&wait=0`, seal(cursor + 1, { from: channel.name, text }));
      if (status === 409) {
        // Missed page; may have more. Read the rest, deliver everything, let the model reconsider.
        let events = json.events as any[];
        let last = json.last;
        if (json.more) {
          const rest = await drain(last);
          events = events.concat(rest.events);
          last = rest.last;
        }
        return { posted: false, conflict: true, newMessages: ingest(events, last) };
      }
      // Our own post is seq=json.id; mark it known. Events are replies after it.
      if (typeof json.id === "number" && json.id > head) head = json.id;
      return { posted: true, id: json.id, newMessages: ingest(json.events, json.last) };
    } catch (e: any) {
      if (e instanceof MayflyFatalError) throw e;
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

  const channel: Channel = {
    id,
    redactedUrl: `${origin}/c/${id}`,
    name,
    get last() {
      return delivered;
    },

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
      const top: number = probe.json.last;
      if (top > head) head = top;
      const { events } = await drain(Math.max(-1, top - count));
      return events.map(open);
    },

    async watch(onBatch, signal, opts) {
      let backoff = 1000;
      while (!signal.aborted && !closer.signal.aborted) {
        try {
          await prime(!!opts?.fromStart, signal, opts?.since);
          const { json } = await request("GET", `since=${delivered}&wait=${WATCH_WAIT}`, undefined, signal);
          backoff = 1000;
          const msgs = ingest(json.events, json.last);
          if (msgs.length && !signal.aborted) onBatch(msgs);
          // If more pages are pending, the next loop iteration fetches them immediately.
        } catch (e: any) {
          if (signal.aborted || closer.signal.aborted) return;
          if (e instanceof MayflyFatalError) throw e;
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
export function formatMessages(msgs: MayflyMessage[]): string {
  return msgs.map((m) => `[#${m.seq} ${m.from || "?"}] ${m.text.replace(/\s+$/, "")}`).join("\n");
}
