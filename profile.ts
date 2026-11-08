// profile.ts — wake/context/budget settings for the Pi `mayfly` extension.
//
// Load order: built-in defaults ← profile file (--profile / $MAYFLY_PROFILE) ← explicit join flags or
// tool args. validateProfile() is pure; loadProfileFile() only adds file reading and name resolution.

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type WakePolicy = "addressed" | "all" | "none";
export type AllowStop = "anyone" | "off" | string[];

export interface Profile {
  /** Default chat name (an explicit join name wins). */
  name?: string;
  /** Group tags: `@<group>` addresses this agent, and `/stop <group>` stops it. */
  groups: string[];
  /** addressed (default): wake on @name, /re to our message, @all, @group. all: wake on any message. none: never auto-wake. */
  wake: WakePolicy;
  context: {
    /** How many unseen, non-addressed messages to include as "while you were away". */
    recentK: number;
    /** Cap on the injected text, in UTF-8 bytes. */
    maxBytes: number;
  };
  budget: {
    /** Token-bucket size: wakes allowed back-to-back. */
    burst: number;
    /** Tokens added per minute. */
    refillPerMinute: number;
    /** Hard cap on wakes per rolling hour; reaching it pauses auto-wake. */
    hourlyCap: number;
    /** After a pause, resume once this many minutes pass with no addressed messages. */
    quietResumeMinutes: number;
    /**
     * Urgent /interrupts accepted per sender per rolling hour (default 6). Within it an interrupt aborts the running
     * work and wakes at once, bypassing the throttle and a pause. Above it, the interrupt is handled as an ordinary
     * addressed message (no abort; normal budget and wake policy).
     */
    interruptsPerHour: number;
  };
  /** Who may `/stop` or `/interrupt` this agent: anyone in the channel, nobody, or these sender names. */
  allowStop: AllowStop;
  /** true (default): only `@name` counts as a mention. false: the bare word `name` does too. */
  requireAtForMention: boolean;
  /** true (default): react 📬 when an addressed message is received and 👀 when it reaches the model. */
  receipts: boolean;
  /**
   * Post a one-time "⏳ busy" notice when an addressed message arrives while one tool call has been running
   * longer than this many seconds (default 30). false disables the notice.
   */
  busyNoticeAfterSec: number | false;
}

export const DEFAULT_PROFILE: Profile = Object.freeze({
  groups: [],
  wake: "addressed",
  context: { recentK: 10, maxBytes: 16 * 1024 },
  budget: { burst: 6, refillPerMinute: 1, hourlyCap: 30, quietResumeMinutes: 10, interruptsPerHour: 6 },
  allowStop: "anyone",
  requireAtForMention: true,
  receipts: true,
  busyNoticeAfterSec: 30,
}) as Profile;

/** Deep-partial profile, as found in a file or built from flags. */
export interface ProfileInput {
  name?: string;
  groups?: string[];
  wake?: WakePolicy;
  context?: Partial<Profile["context"]>;
  budget?: Partial<Profile["budget"]>;
  allowStop?: AllowStop;
  requireAtForMention?: boolean;
  receipts?: boolean;
  busyNoticeAfterSec?: number | false;
}

export const WAKE_POLICIES: readonly WakePolicy[] = ["addressed", "all", "none"];
const GROUP_RE = /^[\p{L}\p{N}_-]+$/u;

/** Validate an untrusted value (parsed JSON or tool args) as a partial profile. Throws with every problem listed. */
export function validateProfile(raw: unknown, source = "profile"): ProfileInput {
  const errs: string[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!isObj(raw)) throw new Error(`${source}: expected a JSON object`);
  const out: ProfileInput = {};
  const known = new Set(["name", "groups", "wake", "context", "budget", "allowStop", "requireAtForMention", "receipts", "busyNoticeAfterSec", "description", "$schema"]);
  for (const k of Object.keys(raw)) if (!known.has(k)) errs.push(`unknown key "${k}"`);

  if (raw.name !== undefined) {
    if (typeof raw.name !== "string" || !raw.name.trim() || raw.name !== raw.name.trim() || /\p{Cc}/u.test(raw.name))
      errs.push("name: must be a nonempty, trimmed string without control characters");
    else out.name = raw.name;
  }
  if (raw.groups !== undefined) {
    if (!Array.isArray(raw.groups) || raw.groups.some((g) => typeof g !== "string" || !GROUP_RE.test(g.replace(/^@/, ""))))
      errs.push("groups: must be an array of tags made of letters, digits, _ or - (e.g. [\"reviewers\"])");
    else out.groups = [...new Set((raw.groups as string[]).map((g) => g.replace(/^@/, "")))];
  }
  if (raw.wake !== undefined) {
    if (!WAKE_POLICIES.includes(raw.wake as WakePolicy)) errs.push(`wake: must be one of ${WAKE_POLICIES.join(", ")}`);
    else out.wake = raw.wake as WakePolicy;
  }
  const nums = (key: "context" | "budget", spec: Record<string, { min: number; int: boolean }>) => {
    const v = raw[key];
    if (v === undefined) return;
    if (!isObj(v)) return void errs.push(`${key}: expected an object`);
    const o: Record<string, number> = {};
    for (const k of Object.keys(v)) {
      const s = spec[k];
      if (!s) {
        errs.push(`${key}.${k}: unknown key`);
        continue;
      }
      const n = v[k];
      if (typeof n !== "number" || !Number.isFinite(n) || n < s.min || (s.int && !Number.isInteger(n)))
        errs.push(`${key}.${k}: must be ${s.int ? "an integer" : "a number"} >= ${s.min}`);
      else o[k] = n;
    }
    (out as any)[key] = o;
  };
  nums("context", { recentK: { min: 0, int: true }, maxBytes: { min: 1024, int: true } });
  nums("budget", {
    burst: { min: 1, int: true },
    refillPerMinute: { min: 0, int: false },
    hourlyCap: { min: 1, int: true },
    quietResumeMinutes: { min: 0, int: false },
    interruptsPerHour: { min: 0, int: true },
  });
  if (raw.allowStop !== undefined) {
    const a = raw.allowStop;
    if (a === "anyone" || a === "off") out.allowStop = a;
    else if (Array.isArray(a) && a.length && a.every((n) => typeof n === "string" && n.trim())) out.allowStop = a.map((n) => n.trim());
    else errs.push('allowStop: must be "anyone", "off", or a nonempty array of sender names');
  }
  if (raw.requireAtForMention !== undefined) {
    if (typeof raw.requireAtForMention !== "boolean") errs.push("requireAtForMention: must be true or false");
    else out.requireAtForMention = raw.requireAtForMention;
  }
  if (raw.receipts !== undefined) {
    if (typeof raw.receipts !== "boolean") errs.push("receipts: must be true or false");
    else out.receipts = raw.receipts;
  }
  if (raw.busyNoticeAfterSec !== undefined) {
    const v = raw.busyNoticeAfterSec;
    if (v === false || (typeof v === "number" && Number.isFinite(v) && v >= 0)) out.busyNoticeAfterSec = v;
    else errs.push("busyNoticeAfterSec: must be a number of seconds >= 0, or false to disable");
  }
  if (errs.length) throw new Error(`${source}: ${errs.join("; ")}`);
  return out;
}

/** Merge layers left to right (later wins); nested context/budget merge per key. */
export function mergeProfile(...layers: (ProfileInput | undefined)[]): Profile {
  const p: Profile = {
    ...DEFAULT_PROFILE,
    groups: [...DEFAULT_PROFILE.groups],
    context: { ...DEFAULT_PROFILE.context },
    budget: { ...DEFAULT_PROFILE.budget },
  };
  for (const l of layers) {
    if (!l) continue;
    if (l.name !== undefined) p.name = l.name;
    if (l.groups !== undefined) p.groups = [...l.groups];
    if (l.wake !== undefined) p.wake = l.wake;
    if (l.allowStop !== undefined) p.allowStop = Array.isArray(l.allowStop) ? [...l.allowStop] : l.allowStop;
    if (l.requireAtForMention !== undefined) p.requireAtForMention = l.requireAtForMention;
    if (l.receipts !== undefined) p.receipts = l.receipts;
    if (l.busyNoticeAfterSec !== undefined) p.busyNoticeAfterSec = l.busyNoticeAfterSec;
    if (l.context) Object.assign(p.context, stripUndefined(l.context));
    if (l.budget) Object.assign(p.budget, stripUndefined(l.budget));
  }
  return p;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Directory of the profiles shipped with the extension (next to index.ts / index.js). */
export const BUNDLED_PROFILES_DIR = join(dirname(fileURLToPath(import.meta.url)), "profiles");

/**
 * Resolve a --profile argument: a path (relative to cwd), or the bare name of a bundled profile
 * (e.g. "subscribed" → profiles/subscribed.json).
 */
export function resolveProfilePath(spec: string, cwd: string, bundledDir = BUNDLED_PROFILES_DIR): string {
  const s = spec.trim();
  if (/^[\w-]+$/.test(s)) {
    const bundled = join(bundledDir, `${s}.json`);
    if (existsSync(bundled)) return bundled;
  }
  return isAbsolute(s) ? s : resolve(cwd, s);
}

export function loadProfileFile(spec: string, cwd: string, bundledDir?: string): { path: string; profile: ProfileInput } {
  const path = resolveProfilePath(spec, cwd, bundledDir);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e: any) {
    throw new Error(`profile ${spec}: cannot read ${path} (${e?.code ?? e?.message ?? e})`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e: any) {
    throw new Error(`profile ${path}: invalid JSON (${e?.message ?? e})`);
  }
  return { path, profile: validateProfile(json, `profile ${path}`) };
}
