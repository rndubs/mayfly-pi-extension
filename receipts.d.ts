export type Clock = () => number;
export declare const RECEIVED = "\uD83D\uDCEC";
export declare const SEEN = "\uD83D\uDC40";
/** `/react N emoji` or `/unreact N emoji`. */
export declare function parseReact(text: string): {
    seq: number;
    emoji: string;
    un: boolean;
} | null;
/** A 📬/👀 receipt reaction (anyone's, to anything). */
export declare function isReceiptReaction(text: string): boolean;
/** Receipts, busy notices and ⏹/⚡/⛔ acks: automatic chatter that must never wake anyone (even under wake=all). */
export declare function isReceiptChatter(text: string): boolean;
export type AckKind = "⏹" | "⚡" | "⛔";
/**
 * A non-waking acknowledgement of a /stop or /interrupt: plain names and `#seq`, no `/re` and no `@`, so it
 * addresses nobody. E.g. `⚡ B interrupted (was running bash, 6m) — handling it (#41 from A)`.
 */
export declare function ackText(kind: AckKind, me: string, what: string, m: {
    seq: number;
    from: string;
}): string;
export declare function parseAck(text: string): {
    kind: AckKind;
    name: string;
    seq: number;
    from: string;
} | null;
/** "45s", "6m", "1h 5m". */
export declare function formatDuration(ms: number): string;
/** Quote a chat name for a slash-command target if it has spaces. */
export declare const quoteTarget: (name: string) => string;
/** The busy notice. Plain names only (no @), so it addresses (and wakes) nobody. */
export declare function busyNoticeText(me: string, seq: number, tool: string, runningMs: number): string;
export declare function parseBusyNotice(text: string): {
    name: string;
    seq: number;
    tool: string;
    running: string;
} | null;
/** Tracks running tool calls and decides when an addressed message deserves a busy notice. */
export declare class BusyTracker {
    private tools;
    private now;
    constructor(now?: Clock);
    toolStart(id: string, name: string): void;
    /** A tool ended: its busy period (and its per-sender dedup) is over. */
    toolEnd(id: string): void;
    /** The run ended (or was aborted): nothing is running. */
    runEnd(): void;
    /** The longest-running tool call, if any. */
    current(): {
        name: string;
        runningMs: number;
    } | null;
    private oldest;
    /**
     * An addressed message from `sender` arrived. If one tool call has run longer than `thresholdMs` and this
     * sender hasn't been told during it, return the notice to post (and remember the sender); else null.
     */
    check(sender: string, seq: number, me: string, thresholdMs: number): string | null;
}
/** Jittered exponential backoff for automatic posts that lost a race: attempt 0 → ~200 ms, doubling, capped at 5 s. */
export declare const BACKOFF: {
    baseMs: number;
    maxMs: number;
    giveUpMs: number;
};
/** Delay before retry number `attempt` (0-based): a random value in [cap/2, cap], cap = min(max, base·2^attempt). */
export declare function backoffDelay(attempt: number, rand?: () => number, b?: {
    baseMs: number;
    maxMs: number;
}): number;
/**
 * `send` outcome: true = posted; null = uncertain (it may have been posted: never retried, so a receipt is never
 * doubled); false = not posted (the caller already retried with backoff and gave up).
 */
export type SendOutcome = boolean | null;
/**
 * Posts receipt reactions one at a time. Each (seq, emoji) is posted at most once: it counts as done only once
 * `send` reports it posted (or possibly posted). A 📬 still waiting when a 👀 for the same seq is queued is dropped
 * (👀 implies received). One that `send` gave up on may be queued again later.
 */
export declare class ReactionQueue {
    private queue;
    private queued;
    private done;
    private running;
    private closed;
    private send;
    private readonly max;
    constructor(send: (seq: number, emoji: string) => Promise<SendOutcome>, max?: number);
    /** Queue a reaction. Returns false if it is already queued or posted. */
    enqueue(seq: number, emoji: string): boolean;
    /** Mark a reaction as already posted (e.g. found in history) so it isn't repeated. */
    remember(key: string): void;
    /** Posted (or possibly posted). */
    has(seq: number, emoji: string): boolean;
    get pending(): number;
    /** Resolves when the queue has drained (tests). */
    idle(): Promise<void>;
    close(): void;
    private pump;
}
/**
 * Who a message of ours is addressed to. Receipts are only sent for DIRECT addressing (@name, or a /re reply to
 * the recipient's own message), so `names` lists exactly the participants whose 📬/👀 we can expect (including
 * @names we haven't seen post yet, listed again in `unseen`). `broadcast`: the message also addresses @all or a
 * known group (`groups`); those members wake but send no receipts.
 */
export interface Targets {
    names: string[];
    broadcast: boolean;
    groups?: string[];
    unseen?: string[];
}
/**
 * Parse whom `text` addresses: known participant names mentioned with @ (longest first, so "Pi Bot" wins over
 * "Pi"), plus the author of the message it replies to. `@all`, or an @tag that is a known group (learned from join
 * intros), is a broadcast. Any other @tag is taken as the exact name of someone who hasn't posted yet: we wait for
 * that name, not for anyone.
 *
 * Names with spaces are only recognized once that participant has posted in the channel (its join intro counts):
 * before that, `@Pi Bot` reads as the exact name `Pi`. We don't guess where an unknown name ends.
 * Returns null if it addresses nobody.
 */
export declare function resolveTargets(text: string, known: Iterable<string>, me: string, replyToAuthor?: string, knownGroups?: Iterable<string>): Targets | null;
/** Why waiting for receipts on a message with these targets is pointless, or null if someone named will send them. */
export declare function noReceiptsExpected(t: Targets | null): string | null;
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
    busy: {
        name: string;
        tool: string;
        running: string;
        at: number;
    }[];
}
export type ReceiptLevel = "received" | "seen";
export interface WaitResult {
    satisfied: boolean;
    aborted: boolean;
    /** Set when the wait was cut short by cancelWaits() (e.g. "left the channel"). */
    cancelled?: string;
    record: OwnRecord;
}
/** Remembers our own messages (newest `max`) and the receipts others posted for them. */
export declare class ReceiptTracker {
    private records;
    private listeners;
    private cancellers;
    private now;
    readonly max: number;
    constructor(max?: number, now?: Clock);
    /** Record one of our posts. */
    noteOwn(seq: number, text: string, targets: Targets | null, postedAt?: number): OwnRecord;
    private ensure;
    private prune;
    /**
     * A reaction from `from` to our message `seq`. Only 📬 and 👀 count; 👀 also implies received.
     * Returns true if it changed anything.
     */
    noteReaction(from: string, seq: number, emoji: string, at?: number): boolean;
    noteBusy(from: string, seq: number, tool: string, running: string, at?: number): void;
    get(seq: number): OwnRecord | undefined;
    /** Newest first. */
    recent(n?: number): OwnRecord[];
    /**
     * Is `rec` acknowledged at `level` by every directly addressed target? With no named target (only @all/@group, or
     * nobody) no receipts are expected, so there is nothing to wait for: false (callers don't wait in that case).
     */
    static satisfied(rec: OwnRecord, level: ReceiptLevel): boolean;
    /** Our addressed messages still missing 📬 or 👀 from a target, newest first. */
    missing(n?: number): {
        rec: OwnRecord;
        noReceived: string[];
        noSeen: string[];
    }[];
    /** Wait until `seq` is acknowledged at `level`, the timeout passes, or `signal` aborts. */
    wait(seq: number, level: ReceiptLevel, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult>;
    /** Resolve every pending wait as not satisfied, with `why` (leave, rejoin, shutdown). Clears their timers. */
    cancelWaits(why: string): void;
    get waiting(): number;
    private emit;
}
/**
 * One line on the receipts for `rec`, e.g. "📬 B after 0.8s; 👀 B after 34s" or
 * "📬 B after 0.8s; no 👀 within 60s; B said it is busy (bash, 6m)". Only directly addressed names are expected
 * to react; @all/@group members send no receipts.
 */
export declare function describeReceipts(rec: OwnRecord, opts?: {
    level?: ReceiptLevel;
    waitedSec?: number;
}): string;
