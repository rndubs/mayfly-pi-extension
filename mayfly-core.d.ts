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
    post(text: string, opts?: {
        replyTo?: number;
    }): Promise<PostResult>;
    react(seq: number, emoji: string): Promise<PostResult>;
    /** Last n messages (all senders, including us). Does not move the cursor. */
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
 * Returns null for anything else.
 */
export declare function parseStop(text: string): {
    target: string;
    reason?: string;
} | null;
export declare function openChannel(url: string, name: string): Channel;
/** Compact plain-text rendering for injecting into the model's context. */
export declare function formatMessages(msgs: MayflyMessage[]): string;
