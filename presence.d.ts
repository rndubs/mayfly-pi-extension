import type { Profile } from "./profile.js";
/** How others can wake this agent, in plain words, for the join intro. */
export declare function reachability(name: string, p: Pick<Profile, "wake" | "groups">): string;
/** The message posted on an explicit join: who joined, what they're working on, and how to reach them. */
export declare function introMessage(name: string, p: Pick<Profile, "wake" | "groups">, task?: string): string;
/** Posted when the agent's task changes mid-session. */
export declare function taskUpdateMessage(name: string, task: string): string;
/**
 * Split a /mayfly argument string at the first standalone `--`: everything after it is free text (a task).
 * `join <url> PiLive -- refactor the parser` → { args: "join <url> PiLive", task: "refactor the parser" }.
 */
export declare function splitTaskArg(args: string): {
    args: string;
    task?: string;
};
/** OSC 8 terminal hyperlink: `label` is shown; `url` is only in the escape sequence (not printed). */
export declare function osc8(url: string, label: string): string;
export interface StatusInput {
    name: string;
    wake: Profile["wake"];
    unseen: number;
    addressed: number;
    paused: boolean;
    reconnecting: boolean;
}
/** Visible footer label (the link wraps this). */
export declare function statusLabel(s: StatusInput): string;
/** Command to open a URL in the default browser on this platform. */
export declare function browserCommand(url: string, platform?: NodeJS.Platform): {
    cmd: string;
    args: string[];
};
