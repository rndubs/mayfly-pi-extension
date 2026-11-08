// presence.ts — how this agent presents itself: the join intro, the Pi footer status, and /mayfly
// argument helpers. Pure functions only (unit-tested); index.ts does the Pi wiring.

import type { Profile } from "./profile.js";

/** How others can wake this agent, in plain words, for the join intro. */
export function reachability(name: string, p: Pick<Profile, "wake" | "groups">): string {
  if (p.wake === "all") return "I read every message here";
  if (p.wake === "none") return `I'm not auto-woken; I check in periodically (you can still @${name} me)`;
  const groups = p.groups.map((g) => ` or @${g}`).join("");
  return `reach me with @${name}${groups}, or reply to one of my messages`;
}

/** The message posted on an explicit join: who joined, what they're working on, and how to reach them. */
export function introMessage(name: string, p: Pick<Profile, "wake" | "groups">, task?: string): string {
  const t = task?.trim();
  return `👋 ${name} joined.${t ? ` Working on: ${t.replace(/\s+/g, " ")}` : ""}\n(${reachability(name, p)}.)`;
}

/**
 * Parse another agent's join intro (see introMessage) to learn its name and the groups it answers to.
 * `👋 B joined. …\n(reach me with @B or @reviewers or @ops, or reply …)` → { name: "B", groups: ["reviewers", "ops"] }.
 */
export function parseIntro(text: string): { name: string; groups: string[] } | null {
  const head = /^👋 (.+?) joined\./u.exec(text);
  if (!head) return null;
  const name = head[1];
  const reach = /\(reach me with ((?:@[\p{L}\p{N}_-]+(?: or )?)+)/u.exec(text);
  const tags = reach ? [...reach[1].matchAll(/@([\p{L}\p{N}_-]+)/gu)].map((m) => m[1]) : [];
  return { name, groups: tags.filter((t) => t.toLowerCase() !== name.toLowerCase()) };
}

/** Posted when the agent's task changes mid-session. */
export function taskUpdateMessage(name: string, task: string): string {
  return `📝 ${name} is now working on: ${task.trim().replace(/\s+/g, " ")}`;
}

/**
 * Split a /mayfly argument string at the first standalone `--`: everything after it is free text (a task).
 * `join <url> PiLive -- refactor the parser` → { args: "join <url> PiLive", task: "refactor the parser" }.
 */
export function splitTaskArg(args: string): { args: string; task?: string } {
  const m = /(^|\s)--(\s|$)/.exec(args);
  if (!m) return { args };
  const task = args.slice(m.index + m[0].length).trim();
  return { args: args.slice(0, m.index).trim(), task: task || undefined };
}

/** OSC 8 terminal hyperlink: `label` is shown; `url` is only in the escape sequence (not printed). */
export function osc8(url: string, label: string): string {
  // Strip anything that could terminate the sequence early.
  const safeUrl = url.replace(/[\x00-\x1f\x7f]/g, "");
  return `\x1b]8;;${safeUrl}\x1b\\${label}\x1b]8;;\x1b\\`;
}

export interface StatusInput {
  name: string;
  wake: Profile["wake"];
  unseen: number;
  addressed: number;
  paused: boolean;
  reconnecting: boolean;
}

/** Visible footer label (the link wraps this). */
export function statusLabel(s: StatusInput): string {
  const parts = [`mayfly: ${s.name}`, s.wake];
  if (s.paused) parts.push("⏸ paused");
  if (s.addressed) parts.push(`${s.addressed} for you`);
  else if (s.unseen) parts.push(`${s.unseen} unseen`);
  if (s.reconnecting) parts.push("⚠ reconnecting");
  return parts.join(" · ");
}

/**
 * The footer status: "💬 mayfly: <name> ↗ · <wake> · …", all one OSC 8 link to the chat. "mayfly: <name>" is
 * underlined and followed by ↗ so it reads as clickable (the URL itself, with its #key, is never printed).
 */
export function statusLine(url: string, s: StatusInput): string {
  const head = `mayfly: ${s.name}`;
  const rest = statusLabel(s).slice(head.length); // " · addressed · …"
  return "💬 " + osc8(url, `\x1b[4m${head}\x1b[24m ↗${rest}`);
}

/** How to open the chat in a browser, for notifications and status. */
export function openHint(platform: NodeJS.Platform = process.platform): string {
  return `${platform === "darwin" ? "Cmd" : "Ctrl"}-click "💬 mayfly" in the footer, or run /mayfly open, to open the chat in your browser.`;
}

/** Command to open a URL in the default browser on this platform. */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] } {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", "", url] };
  return { cmd: "xdg-open", args: [url] };
}
