import { test } from "node:test";
import assert from "node:assert/strict";
import { browserCommand, introMessage, osc8, parseIntro, reachability, splitTaskArg, statusLabel, taskUpdateMessage } from "../presence.ts";
import { mergeProfile } from "../profile.ts";

test("introMessage: name, task, and how to reach the agent", () => {
  const m = introMessage("PiLive", mergeProfile({ groups: ["reviewers"] }), "  refactor the   parser\nand add tests ");
  assert.equal(m, "👋 PiLive joined. Working on: refactor the parser and add tests\n(reach me with @PiLive or @reviewers, or reply to one of my messages.)");
  assert.equal(introMessage("A", mergeProfile()), "👋 A joined.\n(reach me with @A, or reply to one of my messages.)");
});

test("reachability reflects the wake policy", () => {
  assert.match(reachability("A", mergeProfile({ wake: "all" })), /every message/);
  assert.match(reachability("A", mergeProfile({ wake: "none" })), /not auto-woken/);
});

test("intro and task messages never address anyone (no wake for others)", () => {
  // They mention our own @name only; other agents are not @-addressed.
  assert.doesNotMatch(introMessage("A", mergeProfile(), "help @B with X").split("\n")[1], /@B/);
  assert.equal(taskUpdateMessage("A", " new\tthing "), "📝 A is now working on: new thing");
});

test("splitTaskArg splits at the first standalone --", () => {
  assert.deepEqual(splitTaskArg("join https://x/c/1#k PiLive -- refactor the parser"), { args: "join https://x/c/1#k PiLive", task: "refactor the parser" });
  assert.deepEqual(splitTaskArg("join url --wake=all -- task -- with dashes"), { args: "join url --wake=all", task: "task -- with dashes" });
  assert.deepEqual(splitTaskArg("join url --no-stop"), { args: "join url --no-stop" });
  assert.deepEqual(splitTaskArg("join url --"), { args: "join url", task: undefined });
  assert.deepEqual(splitTaskArg("-- only a task"), { args: "", task: "only a task" });
});

test("osc8 wraps the label; the URL is not part of the visible text", () => {
  const s = osc8("https://h/c/ID#secretkey", "mayfly: A");
  assert.equal(s, "\x1b]8;;https://h/c/ID#secretkey\x1b\\mayfly: A\x1b]8;;\x1b\\");
  // Strip escape sequences the way a terminal would display them.
  const visible = s.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");
  assert.equal(visible, "mayfly: A");
  // Control chars in the URL cannot break out of the sequence.
  assert.equal(osc8("https://h/\x1b\\evil\n", "x"), "\x1b]8;;https://h/\\evil\x1b\\x\x1b]8;;\x1b\\");
});

test("statusLabel", () => {
  const base = { name: "A", wake: "addressed" as const, unseen: 0, addressed: 0, paused: false, reconnecting: false };
  assert.equal(statusLabel(base), "mayfly: A · addressed");
  assert.equal(statusLabel({ ...base, unseen: 3 }), "mayfly: A · addressed · 3 unseen");
  assert.equal(statusLabel({ ...base, unseen: 3, addressed: 1 }), "mayfly: A · addressed · 1 for you");
  assert.equal(statusLabel({ ...base, paused: true, reconnecting: true }), "mayfly: A · addressed · ⏸ paused · ⚠ reconnecting");
});

test("browserCommand per platform", () => {
  assert.deepEqual(browserCommand("u", "darwin"), { cmd: "open", args: ["u"] });
  assert.deepEqual(browserCommand("u", "linux"), { cmd: "xdg-open", args: ["u"] });
  assert.deepEqual(browserCommand("u", "win32"), { cmd: "cmd", args: ["/c", "start", "", "u"] });
});

test("parseIntro round-trips introMessage and learns groups", () => {
  assert.deepEqual(parseIntro(introMessage("PiLive", mergeProfile({ groups: ["reviewers", "ops"] }), "x")), { name: "PiLive", groups: ["reviewers", "ops"] });
  assert.deepEqual(parseIntro(introMessage("A", mergeProfile())), { name: "A", groups: [] });
  assert.equal(parseIntro("hello"), null);
});
