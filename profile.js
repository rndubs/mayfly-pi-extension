// profile.ts — wake/context/budget settings for the Pi `mayfly` extension.
//
// Load order: built-in defaults ← profile file (--profile / $MAYFLY_PROFILE) ← explicit join flags or
// tool args. validateProfile() is pure; loadProfileFile() only adds file reading and name resolution.
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export const DEFAULT_PROFILE = Object.freeze({
    groups: [],
    wake: "addressed",
    context: { recentK: 10, maxBytes: 16 * 1024 },
    budget: { burst: 6, refillPerMinute: 1, hourlyCap: 30, quietResumeMinutes: 10 },
    allowStop: "anyone",
    requireAtForMention: true,
});
export const WAKE_POLICIES = ["addressed", "all", "none"];
const GROUP_RE = /^[\p{L}\p{N}_-]+$/u;
/** Validate an untrusted value (parsed JSON or tool args) as a partial profile. Throws with every problem listed. */
export function validateProfile(raw, source = "profile") {
    const errs = [];
    const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
    if (!isObj(raw))
        throw new Error(`${source}: expected a JSON object`);
    const out = {};
    const known = new Set(["name", "groups", "wake", "context", "budget", "allowStop", "requireAtForMention", "description", "$schema"]);
    for (const k of Object.keys(raw))
        if (!known.has(k))
            errs.push(`unknown key "${k}"`);
    if (raw.name !== undefined) {
        if (typeof raw.name !== "string" || !raw.name.trim() || raw.name !== raw.name.trim() || /\p{Cc}/u.test(raw.name))
            errs.push("name: must be a nonempty, trimmed string without control characters");
        else
            out.name = raw.name;
    }
    if (raw.groups !== undefined) {
        if (!Array.isArray(raw.groups) || raw.groups.some((g) => typeof g !== "string" || !GROUP_RE.test(g.replace(/^@/, ""))))
            errs.push("groups: must be an array of tags made of letters, digits, _ or - (e.g. [\"reviewers\"])");
        else
            out.groups = [...new Set(raw.groups.map((g) => g.replace(/^@/, "")))];
    }
    if (raw.wake !== undefined) {
        if (!WAKE_POLICIES.includes(raw.wake))
            errs.push(`wake: must be one of ${WAKE_POLICIES.join(", ")}`);
        else
            out.wake = raw.wake;
    }
    const nums = (key, spec) => {
        const v = raw[key];
        if (v === undefined)
            return;
        if (!isObj(v))
            return void errs.push(`${key}: expected an object`);
        const o = {};
        for (const k of Object.keys(v)) {
            const s = spec[k];
            if (!s) {
                errs.push(`${key}.${k}: unknown key`);
                continue;
            }
            const n = v[k];
            if (typeof n !== "number" || !Number.isFinite(n) || n < s.min || (s.int && !Number.isInteger(n)))
                errs.push(`${key}.${k}: must be ${s.int ? "an integer" : "a number"} >= ${s.min}`);
            else
                o[k] = n;
        }
        out[key] = o;
    };
    nums("context", { recentK: { min: 0, int: true }, maxBytes: { min: 1024, int: true } });
    nums("budget", {
        burst: { min: 1, int: true },
        refillPerMinute: { min: 0, int: false },
        hourlyCap: { min: 1, int: true },
        quietResumeMinutes: { min: 0, int: false },
    });
    if (raw.allowStop !== undefined) {
        const a = raw.allowStop;
        if (a === "anyone" || a === "off")
            out.allowStop = a;
        else if (Array.isArray(a) && a.length && a.every((n) => typeof n === "string" && n.trim()))
            out.allowStop = a.map((n) => n.trim());
        else
            errs.push('allowStop: must be "anyone", "off", or a nonempty array of sender names');
    }
    if (raw.requireAtForMention !== undefined) {
        if (typeof raw.requireAtForMention !== "boolean")
            errs.push("requireAtForMention: must be true or false");
        else
            out.requireAtForMention = raw.requireAtForMention;
    }
    if (errs.length)
        throw new Error(`${source}: ${errs.join("; ")}`);
    return out;
}
/** Merge layers left to right (later wins); nested context/budget merge per key. */
export function mergeProfile(...layers) {
    const p = {
        ...DEFAULT_PROFILE,
        groups: [...DEFAULT_PROFILE.groups],
        context: { ...DEFAULT_PROFILE.context },
        budget: { ...DEFAULT_PROFILE.budget },
    };
    for (const l of layers) {
        if (!l)
            continue;
        if (l.name !== undefined)
            p.name = l.name;
        if (l.groups !== undefined)
            p.groups = [...l.groups];
        if (l.wake !== undefined)
            p.wake = l.wake;
        if (l.allowStop !== undefined)
            p.allowStop = Array.isArray(l.allowStop) ? [...l.allowStop] : l.allowStop;
        if (l.requireAtForMention !== undefined)
            p.requireAtForMention = l.requireAtForMention;
        if (l.context)
            Object.assign(p.context, stripUndefined(l.context));
        if (l.budget)
            Object.assign(p.budget, stripUndefined(l.budget));
    }
    return p;
}
function stripUndefined(o) {
    return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
/** Directory of the profiles shipped with the extension (next to index.ts / index.js). */
export const BUNDLED_PROFILES_DIR = join(dirname(fileURLToPath(import.meta.url)), "profiles");
/**
 * Resolve a --profile argument: a path (relative to cwd), or the bare name of a bundled profile
 * (e.g. "subscribed" → profiles/subscribed.json).
 */
export function resolveProfilePath(spec, cwd, bundledDir = BUNDLED_PROFILES_DIR) {
    const s = spec.trim();
    if (/^[\w-]+$/.test(s)) {
        const bundled = join(bundledDir, `${s}.json`);
        if (existsSync(bundled))
            return bundled;
    }
    return isAbsolute(s) ? s : resolve(cwd, s);
}
export function loadProfileFile(spec, cwd, bundledDir) {
    const path = resolveProfilePath(spec, cwd, bundledDir);
    let text;
    try {
        text = readFileSync(path, "utf8");
    }
    catch (e) {
        throw new Error(`profile ${spec}: cannot read ${path} (${e?.code ?? e?.message ?? e})`);
    }
    let json;
    try {
        json = JSON.parse(text);
    }
    catch (e) {
        throw new Error(`profile ${path}: invalid JSON (${e?.message ?? e})`);
    }
    return { path, profile: validateProfile(json, `profile ${path}`) };
}
