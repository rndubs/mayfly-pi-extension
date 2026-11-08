// receipts.ts — delivery receipts and busy notices for the Pi `mayfly` extension (pure; no Pi, no network).
//
// Recipient side: when a message addressed to us arrives, we react 📬 ("received, queued"); when it is placed
// in the model's context, we react 👀 ("seen"). ReactionQueue posts those one at a time, at most once per
// (seq, emoji). BusyTracker decides when to post a one-time "⏳ busy" notice.
// Sender side: ReceiptTracker records which participants reacted 📬/👀 to our own messages, so mayfly_post
// can wait for them and mayfly_status can list what is still missing.

export type Clock = () => number;

export const RECEIVED = "📬";
export const SEEN = "👀";

/** `/react N emoji` or `/unreact N emoji`. */
export function parseReact(text: string): { seq: number; emoji: string; un: boolean } | null {
  const m = /^\/(un)?react\s+(\d+)\s+(\S+)\s*$/iu.exec(text);
  return m ? { seq: Number(m[2]), emoji: m[3].replace(/️/g, ""), un: !!m[1] } : null;
}

/** A 📬/👀 receipt reaction (anyone's, to anything). */
export function isReceiptReaction(text: string): boolean {
  const r = parseReact(text);
  return !!r && (r.emoji === RECEIVED || r.emoji === SEEN);
}

/** Receipts and busy notices: automatic chatter that must never wake anyone (even under wake=all). */
export function isReceiptChatter(text: string): boolean {
  return isReceiptReaction(text) || parseBusyNotice(text) !== null;
}

// --- busy notice ---------------------------------------------------------------

/** "45s", "6m", "1h 5m". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** Quote a chat name for a slash-command target if it has spaces. */
export const quoteTarget = (name: string) => (/\s/.test(name) ? `"${name}"` : name);

/** The busy notice. Plain names only (no @), so it addresses (and wakes) nobody. */
export function busyNoticeText(me: string, seq: number, tool: string, runningMs: number): string {
  return (
    `⏳ ${me} got #${seq} but is busy (${tool}, running ${formatDuration(runningMs)}). ` +
    `It will read it after the current step; /interrupt ${quoteTarget(me)} <message> to break in.`
  );
}

export function parseBusyNotice(text: string): { name: string; seq: number; tool: string; running: string } | null {
  const m = /^⏳ (.+?) got #(\d+) but is busy \((.+), running ([^)]+)\)/u.exec(text);
  return m ? { name: m[1], seq: Number(m[2]), tool: m[3], running: m[4] } : null;
}

interface RunningTool {
  name: string;
  start: number;
  /** Senders already told about this tool call (dedup: one notice per sender per busy period). */
  notified: Set<string>;
}

/** Tracks running tool calls and decides when an addressed message deserves a busy notice. */
export class BusyTracker {
  private tools = new Map<string, RunningTool>();
  private now: Clock;
  constructor(now: Clock = Date.now) {
    this.now = now;
  }
  toolStart(id: string, name: string) {
    this.tools.set(id, { name, start: this.now(), notified: new Set() });
  }
  /** A tool ended: its busy period (and its per-sender dedup) is over. */
  toolEnd(id: string) {
    this.tools.delete(id);
  }
  /** The run ended (or was aborted): nothing is running. */
  runEnd() {
    this.tools.clear();
  }
  /** The longest-running tool call, if any. */
  current(): { name: string; runningMs: number } | null {
    const t = this.oldest();
    return t ? { name: t.name, runningMs: this.now() - t.start } : null;
  }
  private oldest(): RunningTool | undefined {
    let o: RunningTool | undefined;
    for (const t of this.tools.values()) if (!o || t.start < o.start) o = t;
    return o;
  }
  /**
   * An addressed message from `sender` arrived. If one tool call has run longer than `thresholdMs` and this
   * sender hasn't been told during it, return the notice to post (and remember the sender); else null.
   */
  check(sender: string, seq: number, me: string, thresholdMs: number): string | null {
    const t = this.oldest();
    if (!t) return null;
    const running = this.now() - t.start;
    if (running <= thresholdMs) return null;
    const key = sender.toLowerCase();
    if (t.notified.has(key)) return null;
    t.notified.add(key);
    return busyNoticeText(me, seq, t.name, running);
  }
}

// --- reaction queue (recipient side) ----------------------------------------------

/**
 * Posts receipt reactions one at a time. Each (seq, emoji) is posted at most once; a 📬 still waiting when a
 * 👀 for the same seq is queued is dropped (👀 implies received). `send` resolves true when posted.
 */
export class ReactionQueue {
  private queue: { seq: number; emoji: string }[] = [];
  private done = new Set<string>();
  private running = false;
  private closed = false;
  private send: (seq: number, emoji: string) => Promise<boolean>;
  private readonly max: number;

  constructor(send: (seq: number, emoji: string) => Promise<boolean>, max = 2000) {
    this.send = send;
    this.max = max;
  }

  /** Queue a reaction. Returns false if it was already queued or posted. */
  enqueue(seq: number, emoji: string): boolean {
    if (this.closed) return false;
    const key = `${seq}:${emoji}`;
    if (this.done.has(key)) return false;
    this.remember(key);
    if (emoji === SEEN) this.queue = this.queue.filter((q) => !(q.seq === seq && q.emoji === RECEIVED));
    this.queue.push({ seq, emoji });
    void this.pump();
    return true;
  }

  /** Mark a reaction as already posted (e.g. found in history) so it isn't repeated. */
  remember(key: string) {
    this.done.add(key);
    if (this.done.size > this.max) this.done.delete(this.done.values().next().value as string);
  }

  has(seq: number, emoji: string) {
    return this.done.has(`${seq}:${emoji}`);
  }

  get pending() {
    return this.queue.length;
  }

  /** Resolves when the queue has drained (tests). */
  async idle(): Promise<void> {
    while (this.running || this.queue.length) await new Promise((r) => setTimeout(r, 10));
  }

  close() {
    this.closed = true;
    this.queue = [];
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.closed) {
        const { seq, emoji } = this.queue.shift()!;
        try {
          await this.send(seq, emoji);
        } catch {
          /* best effort */
        }
      }
    } finally {
      this.running = false;
    }
  }
}

// --- receipt tracking (sender side) -------------------------------------------------

/** Who a message of ours is addressed to. `anyone`: @all or a group (any reactor counts). */
export interface Targets {
  names: string[];
  anyone: boolean;
}

const NAME_CH = "\\p{L}\\p{N}_\\-";
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Parse whom `text` addresses: known participant names mentioned with @ (longest first, so "Pi Bot" wins over
 * "Pi"), plus the author of the message it replies to. @all, or any other @tag (a group, or a name we haven't
 * seen yet), means anyone. Returns null if it addresses nobody.
 */
export function resolveTargets(text: string, known: Iterable<string>, me: string, replyToAuthor?: string): Targets | null {
  const names: string[] = [];
  const add = (n: string) => {
    if (n.toLowerCase() !== me.toLowerCase() && !names.some((x) => x.toLowerCase() === n.toLowerCase())) names.push(n);
  };
  let rest = text;
  const sorted = [...new Set(known)].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const n of sorted) {
    const re = new RegExp(`(?<![${NAME_CH}@.])@${escapeRe(n)}(?![${NAME_CH}@])(?!\\.[${NAME_CH}])`, "giu");
    if (re.test(rest)) {
      add(n);
      rest = rest.replace(re, " ");
    }
  }
  let anyone = false;
  const tagRe = new RegExp(`(?<![${NAME_CH}@.])@([${NAME_CH}]+)(?![@])`, "gu");
  for (const m of rest.matchAll(tagRe)) if (m[1].toLowerCase() !== me.toLowerCase()) anyone = true;
  if (replyToAuthor) add(replyToAuthor);
  return names.length || anyone ? { names, anyone } : null;
}

export interface OwnRecord {
  seq: number;
  /** Start of the text (for status). */
  text: string;
  postedAt: number;
  targets: Targets | null;
  /** participant → first time they reacted 📬 / 👀. */
  received: Map<string, number>;
  seen: Map<string, number>;
  /** Busy notices others posted about this message. */
  busy: { name: string; tool: string; running: string; at: number }[];
}

export type ReceiptLevel = "received" | "seen";

export interface WaitResult {
  satisfied: boolean;
  aborted: boolean;
  record: OwnRecord;
}

/** Remembers our own messages (newest `max`) and the receipts others posted for them. */
export class ReceiptTracker {
  private records = new Map<number, OwnRecord>();
  private listeners = new Set<() => void>();
  private now: Clock;
  readonly max: number;

  constructor(max = 200, now: Clock = Date.now) {
    this.max = max;
    this.now = now;
  }

  /** Record one of our posts. */
  noteOwn(seq: number, text: string, targets: Targets | null, postedAt = this.now()): OwnRecord {
    const existing = this.records.get(seq);
    const rec: OwnRecord = existing ?? { seq, text: "", postedAt, targets: null, received: new Map(), seen: new Map(), busy: [] };
    rec.text = text.replace(/\s+/g, " ").slice(0, 80);
    rec.targets = targets;
    rec.postedAt = postedAt;
    this.records.set(seq, rec);
    this.prune();
    this.emit();
    return rec;
  }

  private ensure(seq: number): OwnRecord {
    let rec = this.records.get(seq);
    if (!rec) {
      rec = { seq, text: "", postedAt: this.now(), targets: null, received: new Map(), seen: new Map(), busy: [] };
      this.records.set(seq, rec);
      this.prune();
    }
    return rec;
  }

  private prune() {
    while (this.records.size > this.max) {
      let min = Infinity;
      for (const s of this.records.keys()) min = Math.min(min, s);
      this.records.delete(min);
    }
  }

  /**
   * A reaction from `from` to our message `seq`. Only 📬 and 👀 count; 👀 also implies received.
   * Returns true if it changed anything.
   */
  noteReaction(from: string, seq: number, emoji: string, at = this.now()): boolean {
    if (!from || (emoji !== RECEIVED && emoji !== SEEN)) return false;
    const rec = this.ensure(seq);
    let changed = false;
    if (!rec.received.has(from)) {
      rec.received.set(from, at);
      changed = true;
    }
    if (emoji === SEEN && !rec.seen.has(from)) {
      rec.seen.set(from, at);
      changed = true;
    }
    if (changed) this.emit();
    return changed;
  }

  noteBusy(from: string, seq: number, tool: string, running: string, at = this.now()) {
    const rec = this.ensure(seq);
    rec.busy.push({ name: from, tool, running, at });
    if (rec.busy.length > 10) rec.busy.shift();
    this.emit();
  }

  get(seq: number) {
    return this.records.get(seq);
  }

  /** Newest first. */
  recent(n = 10): OwnRecord[] {
    return [...this.records.values()].sort((a, b) => b.seq - a.seq).slice(0, n);
  }

  /** Is `rec` acknowledged at `level` by its targets (all named targets; or anyone for @all/@group/unaddressed)? */
  static satisfied(rec: OwnRecord, level: ReceiptLevel): boolean {
    const got = level === "seen" ? rec.seen : rec.received;
    const names = rec.targets?.names ?? [];
    if (names.length) return names.every((n) => has(got, n));
    return got.size > 0;
  }

  /** Our addressed messages still missing 📬 or 👀 from a target, newest first. */
  missing(n = 10): { rec: OwnRecord; noReceived: string[]; noSeen: string[] }[] {
    const out: { rec: OwnRecord; noReceived: string[]; noSeen: string[] }[] = [];
    for (const rec of this.recent(this.max)) {
      if (!rec.targets) continue;
      const who = rec.targets.names.length ? rec.targets.names : ["anyone"];
      const lacks = (m: Map<string, number>) => (rec.targets!.names.length ? who.filter((w) => !has(m, w)) : m.size ? [] : who);
      const noReceived = lacks(rec.received);
      const noSeen = lacks(rec.seen);
      if (noReceived.length || noSeen.length) out.push({ rec, noReceived, noSeen });
      if (out.length >= n) break;
    }
    return out;
  }

  /** Wait until `seq` is acknowledged at `level`, the timeout passes, or `signal` aborts. */
  wait(seq: number, level: ReceiptLevel, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult> {
    const rec = this.ensure(seq);
    return new Promise((resolve) => {
      let t: ReturnType<typeof setTimeout> | undefined;
      const finish = (satisfied: boolean, aborted = false) => {
        this.listeners.delete(check);
        if (t) clearTimeout(t);
        signal?.removeEventListener("abort", onAbort);
        resolve({ satisfied, aborted, record: this.records.get(seq) ?? rec });
      };
      const check = () => {
        if (ReceiptTracker.satisfied(this.records.get(seq) ?? rec, level)) finish(true);
      };
      const onAbort = () => finish(false, true);
      if (signal?.aborted) return onAbort();
      this.listeners.add(check);
      signal?.addEventListener("abort", onAbort, { once: true });
      t = setTimeout(() => finish(ReceiptTracker.satisfied(this.records.get(seq) ?? rec, level)), timeoutMs);
      check();
    });
  }

  private emit() {
    for (const l of [...this.listeners]) l();
  }
}

function has(m: Map<string, number>, name: string) {
  for (const k of m.keys()) if (k.toLowerCase() === name.toLowerCase()) return true;
  return false;
}
function getCI(m: Map<string, number>, name: string) {
  for (const [k, v] of m) if (k.toLowerCase() === name.toLowerCase()) return v;
  return undefined;
}

const secs = (ms: number) => (ms < 10_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : formatDuration(ms));

/**
 * One line on the receipts for `rec`, e.g. "📬 B after 0.8s; 👀 B after 34s" or
 * "📬 B after 0.8s; no 👀 within 60s; B said it is busy (bash, 6m)".
 */
export function describeReceipts(rec: OwnRecord, opts: { level?: ReceiptLevel; waitedSec?: number } = {}): string {
  const parts: string[] = [];
  const names = rec.targets?.names.length ? rec.targets.names : null;
  const who = names ?? [...rec.received.keys()];
  const within = opts.waitedSec !== undefined ? ` within ${opts.waitedSec}s` : " yet";
  for (const n of who) {
    const r = getCI(rec.received, n);
    if (r !== undefined) parts.push(`${RECEIVED} ${n} after ${secs(r - rec.postedAt)}`);
  }
  for (const n of who) {
    const s = getCI(rec.seen, n);
    if (s !== undefined) parts.push(`${SEEN} ${n} after ${secs(s - rec.postedAt)}`);
  }
  if (!rec.received.size) {
    parts.push(
      `no ${RECEIVED}${within}${names ? ` from ${names.join(", ")}` : ""} — the recipient may not be running (or has receipts turned off)`,
    );
  } else {
    const noRecv = names ? names.filter((n) => !has(rec.received, n)) : [];
    if (noRecv.length) parts.push(`no ${RECEIVED} from ${noRecv.join(", ")}${within}`);
    if (opts.level === "seen" || opts.level === undefined) {
      const noSeen = names ? names.filter((n) => !has(rec.seen, n)) : rec.seen.size ? [] : ["anyone"];
      if (noSeen.length) parts.push(`no ${SEEN}${names && names.length > 1 ? ` from ${noSeen.join(", ")}` : ""}${within}`);
    }
  }
  const seenBusy = new Set<string>();
  for (const b of [...rec.busy].reverse()) {
    if (seenBusy.has(b.name.toLowerCase())) continue;
    seenBusy.add(b.name.toLowerCase());
    parts.push(`${b.name} said it is busy (${b.tool}, ${b.running})`);
  }
  return parts.join("; ");
}
