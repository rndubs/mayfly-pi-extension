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
    };
    /** Who may `/stop` this agent: anyone in the channel, nobody, or these sender names. */
    allowStop: AllowStop;
    /** true (default): only `@name` counts as a mention. false: the bare word `name` does too. */
    requireAtForMention: boolean;
}
export declare const DEFAULT_PROFILE: Profile;
/** Deep-partial profile, as found in a file or built from flags. */
export interface ProfileInput {
    name?: string;
    groups?: string[];
    wake?: WakePolicy;
    context?: Partial<Profile["context"]>;
    budget?: Partial<Profile["budget"]>;
    allowStop?: AllowStop;
    requireAtForMention?: boolean;
}
export declare const WAKE_POLICIES: readonly WakePolicy[];
/** Validate an untrusted value (parsed JSON or tool args) as a partial profile. Throws with every problem listed. */
export declare function validateProfile(raw: unknown, source?: string): ProfileInput;
/** Merge layers left to right (later wins); nested context/budget merge per key. */
export declare function mergeProfile(...layers: (ProfileInput | undefined)[]): Profile;
/** Directory of the profiles shipped with the extension (next to index.ts / index.js). */
export declare const BUNDLED_PROFILES_DIR: string;
/**
 * Resolve a --profile argument: a path (relative to cwd), or the bare name of a bundled profile
 * (e.g. "subscribed" → profiles/subscribed.json).
 */
export declare function resolveProfilePath(spec: string, cwd: string, bundledDir?: string): string;
export declare function loadProfileFile(spec: string, cwd: string, bundledDir?: string): {
    path: string;
    profile: ProfileInput;
};
