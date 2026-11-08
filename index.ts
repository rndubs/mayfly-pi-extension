// index.ts — Pi `mayfly` extension.
//
// Runs a background watcher for a Mayfly chat channel so Pi never has to block its main loop on a
// read. The agent is dark by default: messages are recorded, and only messages addressed to it
// (@name, /re to its message, @all, @group) wake a turn, subject to a wake budget. Every feature is
// available both as an LLM tool and as a /mayfly subcommand; both call the same functions.
//
// Division of labor: mayfly-core.ts owns crypto, transport, the cursor, dedup, "skip our own messages",
// and 409 handling. policy.ts owns the pure wake/context/budget logic, profile.ts the settings. This
// file owns Pi wiring: tools, commands, the session lifecycle, timers, and delivery.

import { spawn } from "node:child_process";
import { Type } from "typebox";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type Channel,
  createChannel,
  formatMessages,
  MayflyFatalError,
  type MayflyMessage,
  openChannel,
  parseInterrupt,
  parseStop,
  type PostResult,
} from "./mayfly-core.js";
import { addressedReason, Inbox, stopTargetsMe, type WakeAction } from "./policy.js";
import {
  BusyTracker,
  describeReceipts,
  formatDuration,
  isReceiptChatter,
  isReceiptReaction,
  parseBusyNotice,
  parseReact,
  quoteTarget,
  ReactionQueue,
  RECEIVED,
  type ReceiptLevel,
  ReceiptTracker,
  resolveTargets,
  SEEN,
} from "./receipts.js";
import { browserCommand, introMessage, osc8, splitTaskArg, statusLabel, taskUpdateMessage } from "./presence.js";
import {
  type AllowStop,
  loadProfileFile,
  mergeProfile,
  type Profile,
  type ProfileInput,
  validateProfile,
  WAKE_POLICIES,
  type WakePolicy,
} from "./profile.js";

/** Persisted in the session file as a "mayfly-join" entry. `url` includes the #key (secret). */
interface JoinConfig {
  url: string;
  name: string;
  /** Fully resolved profile (v0.3+). */
  profile?: Profile;
  /** Where the profile came from, for status only. */
  profilePath?: string;
  /** What this agent is working on; announced on join and shown in status. */
  task?: string;
  /** Legacy (v0.2) fields. */
  mentionOnly?: boolean;
  allowStop?: AllowStop;
}

export interface JoinRequest {
  url: string;
  name?: string;
  /** Profile path or bundled profile name; defaults to $MAYFLY_PROFILE. */
  profile?: string;
  /** Explicit overrides (highest precedence). */
  overrides?: ProfileInput;
  /** One line on what this agent is working on (posted in the join intro). */
  task?: string;
}

const ONE_CHANNEL =
  "One chat per agent: leave first (mayfly_leave or /mayfly leave). To work in another channel at the same time, " +
  "start a subagent and have it join that channel.";

const DEFAULT_ORIGIN = "https://mayfly.chat";
/** Coalesce batches arriving back-to-back (e.g. several pages on resume) into one wake. */
const COALESCE_MS = 250;
/** After a run ends, how long to wait before treating a never-seen injection as lost (and requeueing it). */
const LOST_INJECTION_MS = 1000;
/** mayfly_post waitFor: default and max wait. */
const WAIT_DEFAULT_SEC = 60;
const WAIT_MAX_SEC = 600;

/** Keep a Set/Map bounded (insertion order: oldest first). */
function bound<K>(c: { size: number; keys(): IterableIterator<K>; delete(k: K): boolean }, max: number) {
  while (c.size > max) c.delete(c.keys().next().value as K);
}

const StringEnum = <T extends string>(values: readonly T[], description: string) =>
  Type.Unsafe<T>({ type: "string", enum: [...values], description });

const text = (t: string, isError = false, details: unknown = undefined) => ({
  content: [{ type: "text" as const, text: t }],
  details,
  ...(isError ? { isError: true } : {}),
});

export default function mayflyExtension(pi: ExtensionAPI) {
  // --- session-scoped state (fresh per runtime; reset on reload/switch) ------
  let channel: Channel | null = null;
  let watcher: AbortController | null = null;
  let config: JoinConfig | null = null;
  let inbox: Inbox | null = null;
  let sessionCtx: ExtensionContext | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerDue = Infinity;
  /** Set while the watcher is retrying after a transient error; cleared after a quiet stretch. */
  let reconnecting = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Receipts (per channel; reset on join).
  /** Reactions on our own messages (sender side). */
  let receipts = new ReceiptTracker(200);
  /** Our 📬/👀 reactions (recipient side). */
  let reactions: ReactionQueue | null = null;
  /** Names seen in the channel, for resolving whom our posts address. */
  const participants = new Set<string>();
  /** seq → author, for "/re N" targets. */
  const authors = new Map<number, string>();
  /** Addressed seqs our watcher received this session (they get 👀 once the model sees them). */
  const receivedAddressed = new Set<number>();
  /** Injected wakes not yet seen in the model's context (message_start), by details.id. */
  const inflight = new Map<string, { taken: Extract<WakeAction, { kind: "wake" }>["taken"]; sentAt: number }>();
  let injectCount = 0;
  let lastStopAt = 0;
  /** /interrupts being handled; ordinary wakes wait for them (the urgent wake takes everything buffered). */
  let urgent = 0;

  // Busy state (per session): which tool calls are running, for the busy notice and the ⚡ reply.
  const busy = new BusyTracker();

  const profile = (): Profile => config?.profile ?? mergeProfile();

  function isWatching() {
    return channel !== null && watcher !== null && !watcher.signal.aborted;
  }

  function stopAllowed(from: string): boolean {
    const allow = profile().allowStop;
    if (allow === "off") return false;
    if (allow === "anyone") return from !== "";
    return allow.some((n) => n.toLowerCase() === from.toLowerCase());
  }

  /**
   * Abort the running turn (bash kills its process tree on abort), then record why. The caller has already
   * checked stopAllowed(). If the channel is left, closed, or the session shuts down while waiting for the
   * aborted run to settle, nothing more is recorded or posted.
   */
  async function handleStop(m: MayflyMessage, reason: string | undefined) {
    const ctx = sessionCtx;
    const ch = channel;
    if (!ctx || !ch) return;
    const stale = () => channel !== ch || sessionCtx !== ctx;
    const wasBusy = !ctx.isIdle();
    lastStopAt = Date.now();
    if (wasBusy) ctx.abort();
    ctx.ui.notify(`Mayfly: ${wasBusy ? "stopped" : "stop requested"} by ${m.from} (#${m.seq})${reason ? ` — ${reason}` : ""}`, "warning");
    // Wait (bounded) for the aborted run to settle before recording the stop.
    for (let i = 0; i < 50 && !ctx.isIdle() && !stale(); i++) await new Promise((r) => setTimeout(r, 200));
    if (stale()) return;
    pi.sendMessage(
      {
        customType: "mayfly-stop",
        content:
          `Your ${wasBusy ? "current work was interrupted" : "session received a stop request"} by "${m.from}" via Mayfly (#${m.seq})` +
          `${reason ? `: ${reason.replace(/[.!?]?$/, ".")}` : "."} Do not resume the interrupted work unless asked again.`,
        display: true,
      },
      { triggerTurn: false },
    );
    void bgPost(wasBusy ? `⏹ ${ch.name} stopped (running work aborted).` : `⏹ ${ch.name} was idle — nothing to stop.`, {
      replyTo: m.seq,
    });
  }

  /**
   * Urgent `/interrupt` (the caller checked stopAllowed()). Busy: abort the running work (bash kills its process
   * tree), wait (bounded) for the run to settle, then wake with the message and a note to decide whether to
   * resume. Idle: an ordinary addressed wake. Either way it bypasses the wake budget's throttle and pause, but
   * counts toward the hourly cap.
   */
  async function handleInterrupt(m: MayflyMessage, message: string | undefined) {
    const ctx = sessionCtx;
    const ch = channel;
    try {
      if (!ctx || !ch || !inbox) return;
      const stale = () => channel !== ch || sessionCtx !== ctx;
      const running = busy.current();
      const wasBusy = !ctx.isIdle();
      if (wasBusy) ctx.abort();
      ctx.ui.notify(`Mayfly: ${wasBusy ? "interrupted" : "urgent message"} by ${m.from} (#${m.seq})${message ? ` — ${message}` : ""}`, "warning");
      for (let i = 0; i < 50 && !ctx.isIdle() && !stale(); i++) await new Promise((r) => setTimeout(r, 200));
      if (stale() || !inbox) return;
      // A wake steered into the aborted run may have been dropped with it: put it back so it rides along.
      requeueInflight(() => true);
      const what = message ? `: ${message}` : ".";
      const note = wasBusy
        ? `${m.from} interrupted your current work via Mayfly (#${m.seq})${what} Decide whether to resume the interrupted work after handling this.`
        : `${m.from} sent you an urgent message via Mayfly (#${m.seq})${what}`;
      inject(inbox.attemptUrgent(header(), m, note));
      refreshStatus();
      const tool = running ? `${running.name}, ${formatDuration(running.runningMs)}` : "a turn";
      void bgPost(wasBusy ? `⚡ ${ch.name} interrupted (was running ${tool}) — handling #${m.seq}` : `⚡ ${ch.name} was idle — handling #${m.seq}`, {
        replyTo: m.seq,
      });
    } finally {
      urgent = Math.max(0, urgent - 1);
      if (!urgent && inbox?.wantsWake()) schedule(COALESCE_MS);
    }
  }

  // --- background posts and receipts -----------------------------------------------

  /**
   * Post something the model didn't ask for (receipts, notices, replies). Messages from others that the post
   * reveals are handed to deliver(), not dropped. Retries a few times on a conflict.
   */
  async function bgPost(text: string, opts?: { replyTo?: number }, react?: { seq: number; emoji: string }): Promise<PostResult | undefined> {
    const ch = channel;
    if (!ch) return;
    for (let i = 0; i < 4 && channel === ch; i++) {
      let r: PostResult;
      try {
        r = react ? await ch.react(react.seq, react.emoji) : await ch.post(text, opts);
      } catch {
        return;
      }
      if (channel === ch && r.newMessages.length) deliver(r.newMessages);
      if (!r.conflict) return r;
    }
  }

  /**
   * Post for the model. A conflict caused only by receipts or busy notices (nothing to reconsider) is retried
   * automatically; those messages go through deliver() as usual.
   */
  async function toolPost(text: string, opts?: { replyTo?: number }): Promise<PostResult> {
    const ch = channel!;
    for (let i = 0; ; i++) {
      const r = await ch.post(text, opts);
      if (!r.conflict || i >= 4 || !r.newMessages.every((m) => isReceiptChatter(m.text))) return r;
      if (channel === ch) deliver(r.newMessages);
    }
  }

  function isAddressed(m: MayflyMessage): boolean {
    return !!channel && addressedReason(m, { name: channel.name, ownSeqs: channel.ownSeqs }, profile()) !== null;
  }

  /** Learn names, authors, receipts and busy notices for our own messages, and (from history) our own receipts. */
  function learn(msgs: MayflyMessage[]) {
    const ch = channel;
    if (!ch) return;
    for (const m of msgs) {
      if (!m.from) continue;
      participants.delete(m.from);
      participants.add(m.from);
      authors.set(m.seq, m.from);
      if (m.from === ch.name) {
        // Our own earlier receipts (seen in history after a restart): don't post them again.
        const r = parseReact(m.text);
        if (r && !r.un && (r.emoji === RECEIVED || r.emoji === SEEN)) reactions?.remember(`${r.seq}:${r.emoji}`);
        continue;
      }
      const r = parseReact(m.text);
      if (r && !r.un && ch.ownSeqs.has(r.seq)) receipts.noteReaction(m.from, r.seq, r.emoji);
      const b = parseBusyNotice(m.text);
      if (b && ch.ownSeqs.has(b.seq)) receipts.noteBusy(m.from, b.seq, b.tool, b.running);
    }
    bound(participants, 500);
    bound(authors, 2000);
  }

  /** The watcher has these (non-control) messages: react 📬 to the addressed ones; maybe post a busy notice. */
  function ackReceived(msgs: MayflyMessage[]) {
    const ch = channel;
    if (!ch) return;
    const p = profile();
    for (const m of msgs) {
      if (!isAddressed(m)) continue;
      receivedAddressed.add(m.seq);
      if (p.receipts) reactions?.enqueue(m.seq, RECEIVED);
      if (p.busyNoticeAfterSec !== false && sessionCtx && !sessionCtx.isIdle()) {
        const notice = busy.check(m.from, m.seq, ch.name, p.busyNoticeAfterSec * 1000);
        if (notice) void bgPost(notice);
      }
    }
    bound(receivedAddressed, 2000);
  }

  /** These seqs are now in the model's context: react 👀 to the addressed ones we received. */
  function markSeenSeqs(seqs: Iterable<number>) {
    if (!profile().receipts) return;
    for (const s of seqs) if (receivedAddressed.has(s)) reactions?.enqueue(s, SEEN);
  }

  /** Messages from others returned in a tool result (the model sees them there). */
  function observeShown(msgs: MayflyMessage[]) {
    if (!channel || !msgs.length) return;
    const control: MayflyMessage[] = [];
    const rest: MayflyMessage[] = [];
    for (const m of msgs) (parseStop(m.text) || parseInterrupt(m.text) ? control : rest).push(m);
    if (control.length) deliver(control);
    learn(rest);
    for (const m of rest) if (isAddressed(m)) receivedAddressed.add(m.seq);
    markSeenSeqs(rest.map((m) => m.seq));
  }

  /** Inject a wake into the conversation. Busy: steer it in after the current tool round. Idle: start a turn. */
  function inject(a: Extract<WakeAction, { kind: "wake" }>) {
    const id = `${Date.now().toString(36)}-${++injectCount}`;
    inflight.set(id, { taken: a.taken, sentAt: Date.now() });
    bound(inflight, 50);
    const isBusy = sessionCtx ? !sessionCtx.isIdle() : false;
    // If the run ends before Pi processes this, Pi itself starts a turn for it (triggerTurn while idle), and
    // deliverAs is ignored. A steer dropped by an abort is caught by the agent_end check (requeueInflight).
    pi.sendMessage(
      { customType: "mayfly", content: a.content, display: true, details: { id, seqs: a.seqs, addressed: a.addressedSeqs } },
      isBusy ? { triggerTurn: true, deliverAs: "steer" } : { triggerTurn: true },
    );
  }

  /** Put the messages of never-seen injections back into the inbox. Returns the oldest sentAt requeued. */
  function requeueInflight(pred: (sentAt: number) => boolean): number | undefined {
    let oldest: number | undefined;
    for (const [id, e] of inflight) {
      if (!pred(e.sentAt)) continue;
      inflight.delete(id);
      inbox?.requeue(e.taken.addressed, e.taken.other);
      oldest = Math.min(oldest ?? Infinity, e.sentAt);
    }
    return oldest;
  }

  // --- footer status ---------------------------------------------------------
  // A clickable link (OSC 8) to the chat: the label is visible, the URL (with its #key) is not printed.

  const STATUS_KEY = "mayfly";

  function refreshStatus() {
    const ctx = sessionCtx;
    if (!ctx?.hasUI) return;
    try {
      if (!channel || !inbox || !config) return ctx.ui.setStatus(STATUS_KEY, undefined);
      const label = statusLabel({
        name: channel.name,
        wake: profile().wake,
        unseen: inbox.unseenCount,
        addressed: inbox.pending.length,
        paused: inbox.budget.isPaused,
        reconnecting,
      });
      ctx.ui.setStatus(STATUS_KEY, "💬 " + osc8(config.url, label));
    } catch {
      /* status is cosmetic; never let it break delivery */
    }
  }

  function noteTransientError(retryInMs: number) {
    reconnecting = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    // No error for a full long-poll cycle after the retry means we're healthy again.
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnecting = false;
      refreshStatus();
    }, retryInMs + 60_000);
    reconnectTimer.unref?.();
    refreshStatus();
  }

  function openChat(): string {
    if (!config || !channel) return "Not in a Mayfly channel.";
    const { cmd, args } = browserCommand(config.url);
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return `Opened ${channel.redactedUrl} in your browser.`;
  }

  // --- delivery ----------------------------------------------------------------

  function schedule(ms: number) {
    if (!Number.isFinite(ms)) return;
    const due = Date.now() + ms;
    if (timer && timerDue <= due) return;
    if (timer) clearTimeout(timer);
    timerDue = due;
    timer = setTimeout(() => {
      timer = null;
      timerDue = Infinity;
      attemptWake();
    }, ms);
    timer.unref?.();
  }

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
    timerDue = Infinity;
  }

  function header() {
    return `Mayfly chat ${channel!.redactedUrl} — you are already connected as "${channel!.name}" (wake policy: ${profile().wake}); no need to join.`;
  }

  function attemptWake() {
    if (!channel || !inbox) return;
    // An /interrupt is being handled: its urgent wake will carry everything buffered.
    if (urgent) return;
    const a = inbox.attempt(header());
    if (a.kind === "wake") {
      if (a.resumed) sessionCtx?.ui.notify("Mayfly: auto-wake resumed after a quiet period", "info");
      inject(a);
      refreshStatus();
    } else if (a.kind === "throttled") {
      schedule(a.retryInMs + 100);
    } else if (a.kind === "paused") {
      // Retry when the quiet rule allows an auto-resume, so held messages are delivered without a new
      // addressed message. A new addressed message pushes the resume time out; the retry then reschedules.
      schedule(a.retryInMs + 100);
      if (!a.justPaused) return;
      refreshStatus();
      const p = profile().budget;
      void bgPost(`⏸ ${channel.name} paused auto-wake: wake budget exhausted (${p.hourlyCap} wakes/hour). It resumes after ${p.quietResumeMinutes} min without addressed messages, or via /mayfly resume.`);
      sessionCtx?.ui.notify(
        `Mayfly: auto-wake paused (wake budget exhausted). Messages are still recorded. Use /mayfly resume or wait ${p.quietResumeMinutes} quiet minutes.`,
        "warning",
      );
    }
  }

  // One poll's worth of messages from others.
  function deliver(incoming: MayflyMessage[]) {
    if (!channel || !inbox) return;
    learn(incoming);
    // /stop aimed at us is handled here and never reaches the model or wakes a turn. /interrupt aimed at us is
    // handled here too, and delivered as an urgent wake.
    let stopped = false;
    let interrupted = false;
    const rest: MayflyMessage[] = [];
    for (const m of incoming) {
      // Receipts are bookkeeping (learn() recorded them): they never wake anyone and aren't shown as context.
      if (isReceiptReaction(m.text)) continue;
      const im = parseInterrupt(m.text);
      if (im && stopTargetsMe(im.target, channel.name, profile().groups)) {
        if (stopAllowed(m.from)) {
          interrupted = true;
          urgent++;
          receivedAddressed.add(m.seq);
          if (profile().receipts) reactions?.enqueue(m.seq, RECEIVED);
          void handleInterrupt(m, im.message);
          continue;
        }
        // Same as a disallowed /stop: say so, record it as an ordinary message, keep pending wakes.
        void bgPost(`⛔ ignoring /interrupt from "${m.from || "?"}" — not allowed to interrupt ${channel.name}`, { replyTo: m.seq });
      }
      const sm = parseStop(m.text);
      if (sm && stopTargetsMe(sm.target, channel.name, profile().groups)) {
        if (stopAllowed(m.from)) {
          stopped = true;
          void handleStop(m, sm.reason);
          continue;
        }
        // Not allowed: say so, and treat it as an ordinary (recorded, non-waking) message. It must not
        // cancel a pending wake.
        void bgPost(`⛔ ignoring /stop from "${m.from || "?"}" — not allowed to stop ${channel.name}`, { replyTo: m.seq });
      }
      rest.push(m);
    }
    ackReceived(rest);
    const want = inbox.add(rest);
    // Don't start new work right after a stop; what arrived stays buffered for the next wake. After an
    // /interrupt, its urgent wake takes what is buffered.
    if (stopped) clearTimer();
    else if (want && !interrupted) schedule(COALESCE_MS);
    if (reconnecting) {
      reconnecting = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    refreshStatus();
  }

  /**
   * Start the watcher. `ready`, if given, gates delivery: batches are held until it settles. Used on resume,
   * so the backlog is classified only after history has told us which seqs are ours (for `/re N`).
   */
  function startWatch(since?: number, ready?: Promise<unknown>) {
    if (!channel) return;
    const w = new AbortController();
    watcher = w;
    let onBatch = deliver;
    if (ready) {
      let held: MayflyMessage[] | null = [];
      onBatch = (msgs) => (held ? held.push(...msgs) : deliver(msgs));
      void ready.finally(() => {
        const msgs = held!;
        held = null;
        if (watcher === w && !w.signal.aborted && msgs.length) deliver(msgs);
      });
    }
    channel
      .watch(onBatch, w.signal, {
        // Resume after a restart so messages posted while Pi was closed are not silently skipped.
        since,
        onError: (e, retryInMs) => {
          sessionCtx?.ui.notify(`Mayfly: transient error (${e.message}); retrying in ${Math.round(retryInMs / 1000)}s`, "warning");
          noteTransientError(retryInMs);
        },
      })
      .catch((e) => {
        if (e instanceof MayflyFatalError && watcher === w) {
          sessionCtx?.ui.notify(`Mayfly: stopped — ${e.message}`, "error");
          teardown();
          config = null;
        }
      });
  }

  function teardown() {
    // Persist the cursor so a later rejoin can resume from where we left off.
    // The channel id is stored with it so a cursor is never applied to a different channel.
    if (channel && channel.last >= 0) pi.appendEntry("mayfly-cursor", { last: channel.last, id: channel.id });
    clearTimer();
    watcher?.abort();
    channel?.close();
    reactions?.close();
    reactions = null;
    inflight.clear();
    watcher = null;
    channel = null;
    inbox = null;
    reconnecting = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    refreshStatus();
  }

  /** Resolve defaults ← profile file ← overrides into a JoinConfig. Throws on bad input. */
  function resolveJoin(req: JoinRequest, cwd: string): JoinConfig {
    const spec = req.profile ?? process.env.MAYFLY_PROFILE;
    const file = spec ? loadProfileFile(spec, cwd) : undefined;
    const overrides = req.overrides ? validateProfile(req.overrides, "join options") : undefined;
    const prof = mergeProfile(file?.profile, overrides);
    const name = req.name?.trim() || prof.name || `Pi-${Math.random().toString(36).slice(2, 6)}`;
    const task = req.task?.trim().replace(/\s+/g, " ") || undefined;
    return { url: req.url, name, profile: prof, profilePath: file?.path, ...(task ? { task } : {}) };
  }

  function normalizeSaved(cfg: JoinConfig): JoinConfig {
    if (cfg.profile) return cfg;
    // v0.2 entry: {mentionOnly, allowStop}. Both old modes map to the new default (addressed).
    return { url: cfg.url, name: cfg.name, profile: mergeProfile(cfg.allowStop ? { allowStop: cfg.allowStop } : undefined) };
  }

  /** Saved watcher cursor: last delivered seq, and (0.4.1+) the channel it belongs to. */
  interface Cursor {
    last: number;
    id?: string;
  }

  /** How long a resume waits for history (our own seqs) before delivering the backlog anyway. */
  const RESUME_HISTORY_WAIT_MS = 5000;

  function join(cfg: JoinConfig, ctx: ExtensionContext, persist: boolean, cursor?: Cursor): string {
    // Explicit joins never silently switch channels.
    if (persist && channel) throw new Error(`Already connected to ${channel.redactedUrl} as "${channel.name}". ${ONE_CHANNEL}`);
    // Validate the new URL/name before leaving the current channel, so a bad join changes nothing.
    const ch = openChannel(cfg.url, cfg.name);
    teardown();
    channel = ch;
    config = normalizeSaved(cfg);
    inbox = new Inbox(config.profile!, { name: ch.name, ownSeqs: ch.ownSeqs });
    receipts = new ReceiptTracker(200);
    participants.clear();
    authors.clear();
    receivedAddressed.clear();
    reactions = new ReactionQueue(async (seq, emoji) => (await bgPost("", undefined, { seq, emoji }))?.posted === true);
    // Only resume from a cursor saved for this channel (legacy cursors have no id).
    const since = cursor && (cursor.id === undefined || cursor.id === ch.id) ? cursor.last : undefined;
    // Learn which recent messages are ours so `/re N` to them wakes us after a restart (best effort).
    const hist = ch
      .history(100)
      .then((msgs) => {
        if (channel === ch) learn(msgs);
      })
      .catch(() => {});
    if (since === undefined) startWatch();
    else {
      // Resuming: hold the backlog until history has filled ownSeqs (bounded), so a `/re` to one of our
      // messages that arrived while Pi was closed is recognized. join itself stays synchronous.
      let t: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((r) => {
        t = setTimeout(r, RESUME_HISTORY_WAIT_MS);
        t.unref?.();
      });
      startWatch(since, Promise.race([hist, timeout]).finally(() => clearTimeout(t)));
    }
    if (persist) {
      // NOTE: cfg.url contains the #key (a password) and is written to the session file so a
      // resumed session can rejoin automatically.
      pi.appendEntry<JoinConfig>("mayfly-join", config);
      // Introduce ourselves on an explicit join (not on silent auto-rejoin after a restart).
      void bgPost(introMessage(ch.name, config.profile!, config.task));
    }
    const summary = `Watching ${ch.redactedUrl} as "${ch.name}" (wake: ${config.profile!.wake}${config.profile!.groups.length ? `, groups: ${config.profile!.groups.join(", ")}` : ""}).`;
    if (ctx.hasUI) ctx.ui.notify(`Mayfly: ${summary}`, "info");
    refreshStatus();
    return summary;
  }

  async function leave(): Promise<string> {
    if (!channel) return "Not in a Mayfly channel.";
    const name = channel.name;
    try {
      await channel.post("👋 leaving, goodbye all");
    } catch {
      /* best effort */
    }
    teardown();
    config = null;
    pi.appendEntry("mayfly-leave", {});
    return `Left the Mayfly channel (was "${name}").`;
  }

  function status(): string {
    if (!channel || !isWatching() || !inbox) return "Not watching any Mayfly channel. Join with mayfly_join or /mayfly join <url> [name].";
    const p = profile();
    const b = inbox.budget.state();
    const allow = Array.isArray(p.allowStop) ? p.allowStop.join(",") : p.allowStop;
    const budget = b.paused
      ? `PAUSED (${b.wakesLastHour}/${b.hourlyCap} wakes this hour; auto-resumes after ${p.budget.quietResumeMinutes} quiet min, or mayfly_resume)`
      : `${b.tokens}/${b.burst} tokens, ${b.wakesLastHour}/${b.hourlyCap} wakes this hour`;
    return [
      `Watching ${channel.redactedUrl} as "${channel.name}"${config?.profilePath ? ` (profile ${config.profilePath})` : ""}`,
      `task: ${config?.task ?? "(not stated)"}`,
      `wake: ${p.wake}; groups: ${p.groups.length ? p.groups.map((g) => "@" + g).join(" ") : "(none)"}; bare-name mentions: ${p.requireAtForMention ? "off" : "on"}`,
      `budget: ${budget}`,
      `unseen: ${inbox.unseenCount} (${inbox.pending.length} addressed); cursor #${channel.last}; remote stop/interrupt: ${allow}`,
      `receipts: ${p.receipts ? "on" : "off"}; busy notice: ${p.busyNoticeAfterSec === false ? "off" : `after ${p.busyNoticeAfterSec}s`}`,
      ...awaitingReceipts(),
    ].join("\n");
  }

  /** Our recent addressed messages still missing 📬 or 👀. */
  function awaitingReceipts(): string[] {
    const miss = receipts.missing(10);
    if (!miss.length) return [];
    const now = Date.now();
    return [
      "awaiting receipts:",
      ...miss.map(({ rec, noReceived, noSeen }) => {
        const gaps = [noReceived.length ? `no ${RECEIVED} from ${noReceived.join(", ")}` : "", noSeen.length ? `no ${SEEN} from ${noSeen.join(", ")}` : ""];
        return `  #${rec.seq} (${formatDuration(now - rec.postedAt)} ago) ${gaps.filter(Boolean).join("; ")}${rec.text ? ` — "${rec.text}"` : ""}`;
      }),
    ];
  }

  function receiptsReport(seq?: number): string {
    if (!channel) return "Not in a Mayfly channel.";
    if (seq !== undefined) {
      const rec = receipts.get(seq);
      if (!rec) return channel.ownSeqs.has(seq) ? `#${seq}: no receipts recorded.` : `#${seq} is not one of your recent messages.`;
      return `#${seq}${rec.text ? ` "${rec.text}"` : ""}: ${describeReceipts(rec)}`;
    }
    const recs = receipts.recent(10).filter((r) => r.text || r.received.size);
    if (!recs.length) return "No receipts tracked yet (post with mayfly_post first).";
    return recs.map((r) => `#${r.seq}${r.text ? ` "${r.text}"` : ""}: ${describeReceipts(r)}`).join("\n");
  }

  function setWake(policy: WakePolicy, groups?: string[]): string {
    if (!config || !inbox || !channel) return "Not in a Mayfly channel.";
    const upd = validateProfile({ wake: policy, ...(groups ? { groups } : {}) }, "wake options");
    config = { ...config, profile: mergeProfile(config.profile, upd) };
    inbox.setProfile(config.profile!);
    pi.appendEntry("mayfly-wake", upd);
    if (inbox.wantsWake()) schedule(COALESCE_MS);
    refreshStatus();
    const p = config.profile!;
    return `Wake policy is now "${p.wake}"${p.groups.length ? `; groups: ${p.groups.map((g) => "@" + g).join(" ")}` : ""}.`;
  }

  function resume(): string {
    if (!inbox) return "Not in a Mayfly channel.";
    const was = inbox.budget.isPaused;
    inbox.resume();
    if (inbox.wantsWake()) schedule(COALESCE_MS);
    refreshStatus();
    return was ? "Auto-wake resumed; the wake budget was reset." : "Auto-wake was not paused; the wake budget was reset.";
  }

  async function setTask(task: string): Promise<string> {
    if (!config || !channel) return "Not in a Mayfly channel.";
    const t = task.trim().replace(/\s+/g, " ");
    if (!t) throw new Error("task must be nonblank");
    config = { ...config, task: t };
    pi.appendEntry("mayfly-task", { task: t });
    const r = (await bgPost(taskUpdateMessage(channel.name, t))) ?? { posted: null, error: "not posted", newMessages: [] };
    return r.posted === true ? `Task updated and announced (#${r.id}).` : `Task updated locally; the announcement was not posted (${r.error ?? (r.conflict ? "conflict" : "unknown")}).`;
  }

  async function newChannel(origin: string | undefined, name: string | undefined, andJoin: boolean, ctx: ExtensionContext, task?: string) {
    if (andJoin && channel) throw new Error(`Already connected to ${channel.redactedUrl} as "${channel.name}". ${ONE_CHANNEL}`);
    const created = await createChannel(origin || DEFAULT_ORIGIN);
    let joined = "";
    if (andJoin) joined = " " + join(resolveJoin({ url: created.url, name, task }, ctx.cwd), ctx, true);
    return { created, joined };
  }

  // --- lifecycle -------------------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    sessionCtx = ctx;
    if (isWatching()) return;
    // Auto-rejoin from the most recent join config in this branch.
    let saved: JoinConfig | undefined;
    let since: Cursor | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      const data = entry.data as any;
      if (entry.customType === "mayfly-join") {
        if (data?.url && data?.name) saved = normalizeSaved(data as JoinConfig);
        since = undefined; // a cursor from before this join belongs to an earlier channel
      } else if (entry.customType === "mayfly-leave") {
        saved = undefined; // a later leave cancels an earlier join
        since = undefined;
      } else if (entry.customType === "mayfly-cursor") {
        if (typeof data?.last === "number") since = { last: data.last, ...(typeof data.id === "string" ? { id: data.id } : {}) };
      } else if (entry.customType === "mayfly-task" && saved) {
        if (typeof data?.task === "string" && data.task.trim()) saved = { ...saved, task: data.task };
      } else if (entry.customType === "mayfly-wake" && saved) {
        try {
          saved = { ...saved, profile: mergeProfile(saved.profile, validateProfile(data, "saved wake")) };
        } catch {}
      }
    }
    if (saved) {
      try {
        join(saved, ctx, false, since);
      } catch (e: any) {
        ctx.ui.notify(`Mayfly: could not rejoin — ${e?.message ?? e}`, "error");
      }
    }
  });

  // --- runtime events: busy state and 👀 receipts ------------------------------
  pi.on("tool_execution_start", async (event) => {
    if (!event?.parentToolCallId && event?.toolCallId) busy.toolStart(event.toolCallId, event.toolName ?? "tool");
  });
  pi.on("tool_execution_end", async (event) => {
    if (event?.toolCallId) busy.toolEnd(event.toolCallId);
  });
  pi.on("message_start", async (event) => {
    // Our injected wake entered the model's context: react 👀 to the addressed messages it carried.
    const msg = event?.message as { role?: string; customType?: string; details?: any } | undefined;
    if (msg?.role !== "custom" || msg.customType !== "mayfly") return;
    const d = msg.details;
    if (typeof d?.id === "string") inflight.delete(d.id);
    if (Array.isArray(d?.addressed)) markSeenSeqs(d.addressed.filter((s: unknown) => typeof s === "number"));
  });
  pi.on("agent_end", async (_event, ctx) => {
    busy.runEnd();
    // A wake steered in during a run that was then aborted can be dropped (or stay queued until the next
    // prompt). If one sent before this run ended still hasn't reached the model shortly after, deliver it again.
    const endedAt = Date.now();
    const ch = channel;
    const t = setTimeout(() => {
      if (channel !== ch || !inbox || !ctx.isIdle()) return;
      const oldest = requeueInflight((sentAt) => sentAt <= endedAt);
      // Not right after a /stop: what was requeued waits for the next wake.
      if (oldest !== undefined && lastStopAt < oldest && inbox.wantsWake()) schedule(COALESCE_MS);
      refreshStatus();
    }, LOST_INJECTION_MS);
    t.unref?.();
  });

  pi.on("session_shutdown", async () => {
    teardown(); // also clears the footer status
    sessionCtx = null;
  });

  // --- /mayfly command -------------------------------------------------------
  const USAGE = [
    "/mayfly join <url> [name] [--profile=<path|name>] [--wake=addressed|all|none] [--groups=a,b] [--mention-only] [--no-stop | --stop-from=A,B] [-- <task>]",
    "/mayfly new [origin] [name] [-- <task>]   (create a channel and join it)",
    "/mayfly wake <addressed|all|none> [groups]",
    "/mayfly task <what you're working on>   (announce a new task)",
    "/mayfly open   (open the chat in your browser)",
    "/mayfly receipts [seq]   (delivery receipts for your messages)",
    "/mayfly resume | leave | status",
  ].join("\n");

  pi.registerCommand("mayfly", {
    description:
      "Mayfly chat: join <url> [name] [--…] [-- task] | new [origin] [name] [-- task] | task <text> | open | wake <policy> | receipts [seq] | resume | leave | status",
    handler: async (rawArgs, ctx) => {
      sessionCtx = ctx;
      const { args, task: taskArg } = splitTaskArg(rawArgs);
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = (tokens.shift() ?? "status").toLowerCase();
      const flag = (n: string) => {
        const i = tokens.findIndex((t) => t === `--${n}` || t.startsWith(`--${n}=`));
        if (i < 0) return undefined;
        const t = tokens[i];
        if (t.includes("=")) return t.slice(t.indexOf("=") + 1);
        // "--flag value" form for flags that take a value.
        const v = tokens[i + 1];
        if (v && !v.startsWith("--")) {
          tokens.splice(i + 1, 1);
          return v;
        }
        return "";
      };
      const list = (s: string | undefined) => (s === undefined ? undefined : s.split(",").map((x) => x.trim()).filter(Boolean));

      try {
        if (sub === "join") {
          const profileSpec = flag("profile");
          const wakeFlag = flag("wake");
          const groups = list(flag("groups"));
          const stopFrom = list(flag("stop-from"));
          const overrides: ProfileInput = {};
          if (tokens.includes("--mention-only")) overrides.wake = "addressed";
          if (wakeFlag) overrides.wake = wakeFlag as WakePolicy;
          if (groups) overrides.groups = groups;
          if (tokens.includes("--no-stop")) overrides.allowStop = "off";
          else if (stopFrom?.length) overrides.allowStop = stopFrom;
          const rest = tokens.filter((t) => !t.startsWith("--"));
          const url = rest.shift() ?? process.env.MAYFLY_URL;
          if (!url) return ctx.ui.notify(`Usage: ${USAGE.split("\n")[0]} (or set $MAYFLY_URL)`, "warning");
          const cfg = resolveJoin({ url, name: rest.join(" ") || undefined, profile: profileSpec || undefined, overrides, task: taskArg }, ctx.cwd);
          join(cfg, ctx, true);
          return;
        }
        if (sub === "new") {
          const origin = tokens[0] && /^https?:\/\//i.test(tokens[0]) ? tokens.shift() : undefined;
          const { created, joined } = await newChannel(origin, tokens.join(" ") || undefined, true, ctx, taskArg);
          // The human asked for it, so show the full URL (it's how they share the channel).
          ctx.ui.notify(`Mayfly: created ${created.url}  (secret: anyone with this URL can read, post, and delete)${joined}`, "info");
          return;
        }
        if (sub === "wake") {
          const policy = (tokens.shift() ?? "").toLowerCase() as WakePolicy;
          if (!WAKE_POLICIES.includes(policy)) return ctx.ui.notify(`Usage: ${USAGE.split("\n")[2]}`, "warning");
          return ctx.ui.notify(`Mayfly: ${setWake(policy, tokens.length ? list(tokens.join(",")) : undefined)}`, "info");
        }
        if (sub === "task") {
          // `/mayfly task <text>` (the rest of the raw line, so no `--` needed).
          const t = rawArgs.trim().replace(/^task\s*/i, "").replace(/^--\s*/, "");
          if (!t) return ctx.ui.notify(`Mayfly: task: ${config?.task ?? "(not stated)"}. Usage: /mayfly task <what you're working on>`, "info");
          return ctx.ui.notify(`Mayfly: ${await setTask(t)}`, "info");
        }
        if (sub === "receipts") {
          const n = tokens[0] ? Number(tokens[0].replace(/^#/, "")) : undefined;
          return ctx.ui.notify(`Mayfly: ${receiptsReport(n !== undefined && Number.isInteger(n) ? n : undefined)}`, "info");
        }
        if (sub === "open") return ctx.ui.notify(`Mayfly: ${openChat()}`, "info");
        if (sub === "resume") return ctx.ui.notify(`Mayfly: ${resume()}`, "info");
        if (sub === "leave") return ctx.ui.notify(`Mayfly: ${await leave()}`, "info");
        if (sub === "status") return ctx.ui.notify(`Mayfly: ${status()}`, "info");
        ctx.ui.notify(`Usage:\n${USAGE}`, "warning");
      } catch (e: any) {
        ctx.ui.notify(`Mayfly: ${sub} failed — ${e?.message ?? e}`, "error");
      }
    },
  });

  // --- tools -----------------------------------------------------------------
  const notJoined = text("Not connected to a Mayfly channel. Use mayfly_join (or mayfly_new to create one) first.", true);

  pi.registerTool(
    defineTool({
      name: "mayfly_join",
      label: "Mayfly Join",
      description:
        "Join a Mayfly chat channel and start watching it in the background. Use when the user gives you a Mayfly " +
        "URL (https://host/c/ID#key) and asks you to join or participate. By default you are dark: you are only woken " +
        "when a message is addressed to you (@yourName, a /re reply to one of your messages, @all, or @group for your " +
        "groups); everything else is recorded and shown as context on your next wake. You post a short intro with " +
        "your task on joining. One chat per agent: if you are already connected, leave first, or start a subagent for " +
        "another channel. The #key in the URL is a secret: never repeat it in chat or output.",
      promptSnippet: "mayfly_join — join a Mayfly chat channel (watch in background; woken only when addressed).",
      parameters: Type.Object({
        url: Type.String({ description: "Full channel URL including #key." }),
        name: Type.Optional(Type.String({ description: "Your chat name (no leading @). Defaults to the profile's name or a random Pi-xxxx." })),
        profile: Type.Optional(Type.String({ description: "Profile JSON path, or a bundled profile name (default, subscribed, reviewer)." })),
        wake: Type.Optional(StringEnum(WAKE_POLICIES, "addressed (default): wake only when addressed; all: wake on every message; none: never auto-wake (poll with mayfly_read).")),
        groups: Type.Optional(Type.Array(Type.String(), { description: "Group tags: @<group> messages address you, e.g. [\"reviewers\"]." })),
        task: Type.String({
          description:
            "One sentence on what you are working on and what others can ask you for. It is posted in your join " +
            "message so other agents and people understand your objective and scope. Don't include secrets.",
        }),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        sessionCtx = ctx;
        if (channel && params.url.trim().replace(/#.*$/, "").replace(/\/+$/, "") === channel.redactedUrl)
          return text(`Already connected to ${channel.redactedUrl} as "${channel.name}". Post with mayfly_post; see mayfly_status.`);
        if (channel) return text(`Already connected to ${channel.redactedUrl} as "${channel.name}". ${ONE_CHANNEL}`, true);
        try {
          const overrides: ProfileInput = {};
          if (params.wake) overrides.wake = params.wake;
          if (params.groups) overrides.groups = params.groups;
          const summary = join(
            resolveJoin({ url: params.url, name: params.name, profile: params.profile, overrides, task: params.task }, ctx.cwd),
            ctx,
            true,
          );
          return text(`${summary} Messages addressed to you will arrive automatically; post with mayfly_post.`);
        } catch (e: any) {
          return text(`Join failed: ${e?.message ?? e}`, true);
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "mayfly_new",
      label: "Mayfly New Channel",
      description:
        "Create a new, empty Mayfly chat channel and (by default) join it. Use only when the user asks for a new " +
        "channel. Returns the full URL including its secret #key: give it only to the user or the participants they " +
        "name, and never post it into another channel.",
      parameters: Type.Object({
        origin: Type.Optional(Type.String({ description: `Server origin (default ${DEFAULT_ORIGIN}).` })),
        name: Type.Optional(Type.String({ description: "Your chat name when joining." })),
        join: Type.Optional(Type.Boolean({ description: "Join the new channel (default true)." })),
        task: Type.Optional(Type.String({ description: "When joining: one sentence on what you're working on (posted in your intro)." })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        sessionCtx = ctx;
        try {
          const { created, joined } = await newChannel(params.origin, params.name, params.join !== false, ctx, params.task);
          return text(
            `Created channel: ${created.url}\nThis URL is a secret (anyone with it can read, post, and delete the channel). ` +
              `Share it only with intended participants; refer to it elsewhere as ${created.redactedUrl}.${joined}`,
            false,
            { redactedUrl: created.redactedUrl },
          );
        } catch (e: any) {
          return text(`Could not create a channel: ${e?.message ?? e}`, true);
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "mayfly_leave",
      label: "Mayfly Leave",
      description: "Post a goodbye to the Mayfly channel and stop watching it. Use when the user asks you to leave the chat.",
      parameters: Type.Object({}),
      async execute() {
        if (!channel) return notJoined;
        return text(await leave());
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "mayfly_status",
      label: "Mayfly Status",
      promptSnippet: "mayfly_status — show the Mayfly connection, wake policy, and budget.",
      description:
        "Show the Mayfly connection: channel (without key), your name, wake policy, groups, wake budget, unseen count, " +
        "cursor, and your recent addressed messages still missing a 📬 (received) or 👀 (seen) receipt.",
      parameters: Type.Object({}),
      async execute() {
        return text(status());
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "mayfly_set_wake",
      label: "Mayfly Set Wake",
      description:
        "Change when Mayfly messages wake you. addressed (default, 'dark'): only @yourName, /re replies to your " +
        "messages, @all, or @group. all: every message from others (subscribe; noisy). none: never auto-wake; check " +
        "with mayfly_read. Optionally replace your group tags. Use when the user asks you to go quiet, follow the " +
        "whole conversation, or join/leave a group.",
      parameters: Type.Object({
        policy: StringEnum(WAKE_POLICIES, "addressed | all | none"),
        groups: Type.Optional(Type.Array(Type.String(), { description: "Replace your group tags (e.g. [\"reviewers\"]); [] clears them." })),
      }),
      async execute(_id, params) {
        if (!channel) return notJoined;
        try {
          return text(setWake(params.policy, params.groups));
        } catch (e: any) {
          return text(`${e?.message ?? e}`, true);
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "mayfly_resume",
      label: "Mayfly Resume",
      description:
        "Resume auto-wake after the wake budget paused it (you or the user saw a '⏸ paused auto-wake' notice). " +
        "Use only when the user asks, or when you are sure the conversation is not a runaway loop.",
      parameters: Type.Object({}),
      async execute() {
        if (!channel) return notJoined;
        return text(resume());
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "mayfly_set_task",
      label: "Mayfly Set Task",
      description:
        "Announce in the Mayfly channel that your task changed (posts '📝 <you> is now working on: …'). Use when your " +
        "objective or scope changes substantially, so others know what you are doing and what to ask you for.",
      parameters: Type.Object({
        task: Type.String({ description: "One sentence on your new task. Don't include secrets." }),
      }),
      async execute(_id, params) {
        if (!channel) return notJoined;
        try {
          return text(await setTask(params.task));
        } catch (e: any) {
          return text(`${e?.message ?? e}`, true);
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "mayfly_post",
      label: "Mayfly Post",
      description:
        "Post a message to the connected Mayfly chat channel. Optionally reply to a message by its #seq. To address " +
        "someone (and wake them), include @theirName; @all addresses everyone. Don't @-mention agents needlessly: it " +
        "wakes them. If another participant posted first (a conflict), the post is NOT sent and the missed messages " +
        "are returned so you can reconsider before trying again. Recipients' extensions react 📬 when they receive an " +
        "addressed message and 👀 when it reaches their model. waitFor=\"received\" or \"seen\" blocks until the " +
        "addressee(s) react at that level (or timeoutSec passes) and reports the receipts; use it only when you need " +
        "to know before continuing.",
      promptSnippet: "mayfly_post — send a message to the Mayfly chat.",
      promptGuidelines: [
        "Mayfly chat: you are only woken when addressed (@yourName, a /re reply to your message, @all, @group). Reply only when it adds something, and @-mention another agent only when you need it to act, since that wakes it.",
      ],
      parameters: Type.Object({
        text: Type.String({ description: "Message text to post." }),
        replyTo: Type.Optional(Type.Number({ description: "Optional #seq of a message to reply to." })),
        waitFor: Type.Optional(
          StringEnum(["received", "seen"] as const, "Wait until the addressee(s) react 📬 (received) or 👀 (seen, i.e. in their model's context)."),
        ),
        timeoutSec: Type.Optional(Type.Number({ description: `With waitFor: max seconds to wait (default ${WAIT_DEFAULT_SEC}, max ${WAIT_MAX_SEC}).` })),
      }),
      async execute(_id, params, signal) {
        if (!channel) return notJoined;
        const ch = channel;
        const postedAt = Date.now();
        const res = await toolPost(params.text, { replyTo: params.replyTo });
        const parts: string[] = [];
        if (res.posted === true && typeof res.id === "number") {
          const targets = resolveTargets(params.text, participants, ch.name, params.replyTo !== undefined ? authors.get(params.replyTo) : undefined);
          receipts.noteOwn(res.id, params.text, targets, postedAt);
        }
        observeShown(res.newMessages);
        if (res.posted === true && typeof res.id === "number" && params.waitFor) {
          const level: ReceiptLevel = params.waitFor;
          const sec = Math.min(WAIT_MAX_SEC, Math.max(1, Math.round(params.timeoutSec ?? WAIT_DEFAULT_SEC)));
          const w = await receipts.wait(res.id, level, sec * 1000, signal);
          parts.push(`Posted #${res.id}. ${describeReceipts(w.record, { level, waitedSec: w.aborted ? undefined : sec })}${w.aborted ? " (wait cancelled)" : ""}`);
        } else if (res.posted === true) parts.push(`Posted as #${res.id}.`);
        else if (res.conflict) parts.push("Conflict: someone posted first — your message was NOT sent. Reconsider, then post again.");
        else if (res.posted === null) parts.push(`Uncertain: ${res.error ?? "network error"}. Use mayfly_read before reposting.`);
        else parts.push(`Not posted: ${res.error ?? "refused"}.`);
        if (res.newMessages.length) {
          parts.push("\nMessages from others:\n" + formatMessages(res.newMessages));
        }
        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          details: { posted: res.posted, id: res.id, conflict: res.conflict },
          isError: res.posted !== true,
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "mayfly_stop",
      label: "Mayfly Stop",
      description:
        "Ask another agent in the Mayfly channel to stop what it is running right now (it aborts its current turn and " +
        "any blocking shell commands). Sends `/stop <name> [reason]`; the target's extension handles it without " +
        "involving its model. Use target \"all\" to stop every agent, or a group tag to stop that group. Only use when " +
        "the user or the situation clearly calls for interrupting that agent.",
      parameters: Type.Object({
        target: Type.String({ description: 'Chat name of the agent to stop (may contain spaces), a group tag, or "all".' }),
        reason: Type.Optional(Type.String({ description: "Short reason shown to the stopped agent." })),
      }),
      async execute(_id, params) {
        if (!channel) return notJoined;
        const target = params.target.trim().replace(/^@/, "");
        if (!target || target.includes('"')) return text('target must be a chat name without double quotes, a group, or "all".', true);
        // A name with spaces is sent quoted: /stop "Pi Bot" reason.
        const res = await toolPost(`/stop ${quoteTarget(target)}${params.reason ? ` ${params.reason}` : ""}`);
        observeShown(res.newMessages);
        const msg =
          res.posted === true
            ? `Stop request sent to ${target} as #${res.id}. It will acknowledge with a ⏹ message.`
            : res.conflict
              ? "Conflict: new messages arrived first; stop NOT sent. Review them and retry if still needed."
              : `Stop request not sent: ${res.error ?? "error"}.`;
        const extra = res.newMessages.length ? "\n\nMessages from others:\n" + formatMessages(res.newMessages) : "";
        return { content: [{ type: "text" as const, text: msg + extra }], details: { posted: res.posted, id: res.id }, isError: res.posted !== true };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "mayfly_interrupt",
      label: "Mayfly Interrupt",
      description:
        "URGENT ONLY. Interrupt another agent in the Mayfly channel: it ABORTS whatever it is running right now " +
        "(its current turn and any shell commands), then handles your message immediately and decides whether to " +
        "resume. Sends `/interrupt <name> <message>`; the target's extension handles it. Use only when waiting for " +
        "the agent to finish its current step would cause real harm or waste (e.g. it is working from wrong " +
        "information, or the user asked to break in). For ordinary requests use mayfly_post with @name (it is read " +
        "after the current step); to stop an agent without new work use mayfly_stop. Target \"all\" or a group tag " +
        "interrupts every matching agent.",
      parameters: Type.Object({
        target: Type.String({ description: 'Chat name of the agent to interrupt (may contain spaces), a group tag, or "all".' }),
        message: Type.String({ description: "What the agent should do or know right now." }),
      }),
      async execute(_id, params) {
        if (!channel) return notJoined;
        const target = params.target.trim().replace(/^@/, "");
        if (!target || target.includes('"')) return text('target must be a chat name without double quotes, a group, or "all".', true);
        const message = params.message.trim();
        if (!message) return text("message must be nonblank.", true);
        const res = await toolPost(`/interrupt ${quoteTarget(target)} ${message}`);
        observeShown(res.newMessages);
        if (res.posted === true && typeof res.id === "number") receipts.noteOwn(res.id, `/interrupt ${target} ${message}`, null);
        const msg =
          res.posted === true
            ? `Interrupt sent to ${target} as #${res.id}. It will acknowledge with a ⚡ reply (or ⛔ if not allowed); see mayfly_receipts ${res.id}.`
            : res.conflict
              ? "Conflict: new messages arrived first; interrupt NOT sent. Review them and retry if still needed."
              : `Interrupt not sent: ${res.error ?? "error"}.`;
        const extra = res.newMessages.length ? "\n\nMessages from others:\n" + formatMessages(res.newMessages) : "";
        return { content: [{ type: "text" as const, text: msg + extra }], details: { posted: res.posted, id: res.id }, isError: res.posted !== true };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "mayfly_receipts",
      label: "Mayfly Receipts",
      description:
        "Delivery receipts for your Mayfly messages: who reacted 📬 (their extension received it) and 👀 (it reached " +
        "their model), with delays, plus any busy notices. No 📬 after a while usually means the recipient isn't " +
        "running (or has receipts off); 📬 without 👀 means it is queued behind the recipient's current work.",
      parameters: Type.Object({
        seq: Type.Optional(Type.Number({ description: "One of your message #seqs; omit for your recent messages." })),
      }),
      async execute(_id, params) {
        if (!channel) return notJoined;
        return text(receiptsReport(params.seq));
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "mayfly_react",
      label: "Mayfly React",
      description: "Add an emoji reaction to a Mayfly message by its #seq. Reactions never wake anyone.",
      parameters: Type.Object({
        seq: Type.Number({ description: "The #seq of the message to react to." }),
        emoji: Type.String({ description: "A single emoji, e.g. 👍" }),
      }),
      async execute(_id, params) {
        if (!channel) return notJoined;
        const res = await channel.react(params.seq, params.emoji);
        if (res.newMessages.length) deliver(res.newMessages); // not shown to the model: deliver as usual
        return text(
          res.posted === true ? `Reacted ${params.emoji} to #${params.seq}.` : `Reaction not sent: ${res.conflict ? "conflict, retry" : (res.error ?? "error")}.`,
          res.posted !== true,
        );
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "mayfly_read",
      label: "Mayfly Read",
      promptSnippet: "mayfly_read — read Mayfly history, or unread=true for messages recorded since your last wake.",
      description:
        "Read Mayfly messages. unread=true returns the messages recorded since your last wake (addressed ones first, " +
        "capped) and marks them seen — use it to catch up when your wake policy is none, or to see more of the " +
        "conversation. Otherwise returns the last `count` messages of history (all senders). Does not move the live " +
        "watcher's cursor.",
      parameters: Type.Object({
        count: Type.Optional(Type.Number({ description: "How many recent history messages to fetch (default 20, max 500)." })),
        unread: Type.Optional(Type.Boolean({ description: "Return unseen recorded messages instead of history." })),
      }),
      async execute(_id, params) {
        if (!channel || !inbox) return notJoined;
        if (params.unread) {
          if (!inbox.unseenCount) return text("(no unseen messages)");
          const out = inbox.take(header(), [], "Use mayfly_read with count to see older history.");
          markSeenSeqs(out.addressedSeqs);
          refreshStatus();
          return text(out.content);
        }
        const msgs = await channel.history(Math.min(500, params.count ?? 20));
        learn(msgs);
        markSeenSeqs(msgs.map((m) => m.seq));
        if (msgs.length) inbox.markSeen(msgs[0].seq, msgs[msgs.length - 1].seq);
        refreshStatus();
        return text(msgs.length ? formatMessages(msgs) : "(no messages yet)", false, { count: msgs.length });
      },
    }),
  );
}
