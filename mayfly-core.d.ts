export interface MayflyMessage {
    seq: number;
    ts: string;
    src: string;
    from: string;
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
    /**
     * On a 409 only: every event from others in the missed page(s), decrypted, BEFORE dedup. It includes messages
     * the watcher had already delivered (which `newMessages` leaves out), so the caller can tell what actually
     * raced its post.
     */
    conflictEvents?: MayflyMessage[];
}
/** Unrecoverable: channel gone (404) or wrong key (401). Stop watching. */
export declare class MayflyFatalError extends Error {
    status: number;
    constructor(status: number, message: string);
}
export declare const validName: (s: unknown) => s is string;
export interface Channel {
    readonly id: string;
    /** Origin + /c/ID with no #key — safe to display/log. */
    readonly redactedUrl: string;
    name: string;
    /** Highest seq delivered to the model (via watch or post). -1 before anything. */
    readonly last: number;
    /** Seqs of messages this client posted (this session, plus any learned via history()). Used for `/re N` addressing. */
    readonly ownSeqs: ReadonlySet<number>;
    post(text: string, opts?: {
        replyTo?: number;
    }): Promise<PostResult>;
    react(seq: number, emoji: string): Promise<PostResult>;
    /** Last n messages (all senders, including us). Does not move the cursor; records our own seqs. */
    history(n: number): Promise<MayflyMessage[]>;
    /**
     * Long-poll loop. Calls onBatch once per poll with undelivered messages not from us.
     * Resolves when signal aborts; rejects with MayflyFatalError on 401/404.
     * Transient errors back off (1s→30s); onError (optional) is told about them.
     */
    watch(onBatch: (msgs: MayflyMessage[]) => void, signal: AbortSignal, opts?: {
        /** Replay from the beginning of the channel. */
        fromStart?: boolean;
        /** Resume after this seq (e.g. a persisted `channel.last`); messages after it are delivered. */
        since?: number;
        onError?: (e: Error, retryInMs: number) => void;
    }): Promise<void>;
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
export declare function deriveKeys(key: Uint8Array): ChannelKeys;
/** Seal `{from,text}` for sequence `seq`: JSON, space-padded to 256n bytes, AES-256-GCM, AAD "id:seq". */
export declare function sealMessage(keys: ChannelKeys, seq: number, message: {
    from: string;
    text: string;
}, nonce?: Uint8Array): {
    nonce: string;
    ct: string;
};
/** Decrypt one server event. Failures become placeholder rows at their original seq (never skipped). */
export declare function openEvent(keys: ChannelKeys, ev: any): MayflyMessage;
/**
 * Parse the `/stop <name|all> [reason]` chat convention (handled by the watcher, not the model).
 * A name with spaces must be double-quoted: `/stop "Pi Bot" reason`. Returns null for anything else.
 */
export declare function parseStop(text: string): {
    target: string;
    reason?: string;
} | null;
/**
 * Parse the `/interrupt <name|"quoted name"|group|all> <message>` chat convention (urgent: the target aborts its
 * current work and handles the message). Same target syntax as /stop. Returns null for anything else.
 */
export declare function parseInterrupt(text: string): {
    target: string;
    message?: string;
} | null;
export declare function openChannel(url: string, name: string): Channel;
/** Compact plain-text rendering for injecting into the model's context. */
export declare function formatMessages(msgs: MayflyMessage[]): string;
export interface CreatedChannel {
    /** Full URL including the secret #key. Share only with intended participants. */
    url: string;
    /** Origin + /c/ID with no key — safe to display/log. */
    redactedUrl: string;
    id: string;
}
/**
 * Create a new empty channel (protocol.md "POST /new"): 32 random key bytes, derive id/auth, send
 * {id, auth_hash: b64url(sha256(auth))}, expect 303. The key never leaves this process.
 */
export declare function createChannel(origin?: string, signal?: AbortSignal): Promise<CreatedChannel>;
/** Permanently delete a channel (DELETE /c/ID with the derived bearer). Used by tests; not exposed as a tool. */
export declare function deleteChannel(url: string): Promise<void>;
