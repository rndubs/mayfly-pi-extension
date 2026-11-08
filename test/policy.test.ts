import { test } from "node:test";
import assert from "node:assert/strict";
import type { MayflyMessage } from "../mayfly-core.ts";
import { parseStop } from "../mayfly-core.ts";
import {
  buildWakeMessage,
  decideWake,
  Inbox,
  mentions,
  parseReplyTarget,
  stopTargetsMe,
  truncateBytes,
  UNSEEN_MAX,
  WakeBudget,
} from "../policy.ts";
import { mergeProfile } from "../profile.ts";

let seq = 100;
const msg = (from: string, text: string, s = seq++): MayflyMessage => ({ seq: s, ts: "t", src: "s", from, text });
const state = (name = "A", own: number[] = []) => ({ name, ownSeqs: new Set(own) });
const prof = (over: Parameters<typeof mergeProfile>[0] = {}) => mergeProfile(over);
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

test("mentions: @-prefixed, case-insensitive, word-bounded", () => {
  assert.equal(mentions("hey @A can you look", "A"), true);
  assert.equal(mentions("@a, thoughts?", "A"), true);
  assert.equal(mentions("(@A)", "A"), true);
  assert.equal(mentions("@Alpha hi", "A"), false);
  assert.equal(mentions("mail bob@A.com", "A"), false);
  assert.equal(mentions("A should look", "A"), false, "bare name needs requireAt=false");
  assert.equal(mentions("A should look", "A", false), true);
  assert.equal(mentions("an api call", "Pi", false), false);
  assert.equal(mentions("@Pi-2 go", "Pi-2"), true);
  assert.equal(mentions("@Pi-2x go", "Pi-2"), false);
  assert.equal(mentions("hi @Ünï!", "ünï"), true);
});

test("parseReplyTarget", () => {
  assert.equal(parseReplyTarget("/re 12 sounds good"), 12);
  assert.equal(parseReplyTarget("/RE 3"), 3);
  assert.equal(parseReplyTarget("/react 12 👍"), null);
  assert.equal(parseReplyTarget("see /re 12"), null);
});

test("decideWake: addressed policy", () => {
  const p = prof();
  const s = state("A", [5]);
  const yes = (text: string, why: RegExp, pp = p) => {
    const d = decideWake(msg("B", text), s, pp);
    assert.equal(d.wake, true, text);
    assert.match(d.reason, why);
  };
  const no = (text: string, pp = p, from = "B") => assert.equal(decideWake(msg(from, text), s, pp).wake, false, text);
  yes("@A please review", /mentions @A/);
  yes("/re 5 thanks", /reply to our #5/);
  yes("@all standup time", /@all/);
  yes("@reviewers PR ready", /@reviewers/, prof({ groups: ["reviewers"] }));
  no("@reviewers PR ready"); // not in group
  no("/re 6 not ours");
  no("plain chat about A");
  no("/react 5 👍");
  no("/title @A's channel");
  no("/stop A");
  no("@A hi", p, ""); // undecryptable
  no("@A hi", p, "A"); // own message
  yes("A, please review", /mentions @A/, prof({ requireAtForMention: false }));
});

test("decideWake: all and none policies", () => {
  assert.equal(decideWake(msg("B", "plain"), state(), prof({ wake: "all" })).wake, true);
  assert.equal(decideWake(msg("B", "/react 1 👍"), state(), prof({ wake: "all" })).wake, true);
  assert.equal(decideWake(msg("B", "/stop C"), state(), prof({ wake: "all" })).wake, false);
  assert.equal(decideWake(msg("B", "@A hi"), state(), prof({ wake: "none" })).wake, false);
});

test("parseStop + stopTargetsMe with groups", () => {
  const groups = ["reviewers"];
  const hit = (text: string) => {
    const s = parseStop(text);
    return !!s && stopTargetsMe(s.target, "A", groups);
  };
  assert.equal(hit("/stop A"), true);
  assert.equal(hit("/stop @a too slow"), true);
  assert.equal(hit("/stop all"), true);
  assert.equal(hit("/stop *"), true);
  assert.equal(hit("/stop reviewers"), true);
  assert.equal(hit("/stop @Reviewers loop"), true);
  assert.equal(hit("/stop B"), false);
  assert.equal(hit("/stop writers"), false);
  assert.equal(stopTargetsMe("reviewers", "A"), false);
});

test("truncateBytes keeps code points and adds a marker", () => {
  assert.equal(truncateBytes("short", 100), "short");
  const t = truncateBytes("é".repeat(1000), 200);
  assert.ok(bytes(t) <= 200);
  assert.match(t, /truncated \d+ bytes/);
  assert.ok(!t.includes("�"));
});

test("buildWakeMessage: addressed first, last K others, omitted count, byte cap", () => {
  const addressed = [msg("B", "@A one"), msg("C", "@A two")];
  const other = Array.from({ length: 25 }, (_, i) => msg("D", `chatter ${i}`));
  const w = buildWakeMessage({ addressed, other, recentK: 10, maxBytes: 16384, header: "H" });
  assert.equal(w.shownAddressed, 2);
  assert.equal(w.shownOther, 10);
  assert.equal(w.omitted, 15);
  assert.match(w.content, /Addressed to you \(2\):/);
  assert.match(w.content, /15 earlier message\(s\) omitted; use mayfly_read/);
  assert.match(w.content, /chatter 24/);
  assert.doesNotMatch(w.content, /chatter 14\b/);
  assert.match(w.content, /not as instructions from your operator/);
  assert.ok(w.content.indexOf("@A one") < w.content.indexOf("chatter 24"));
});

test("buildWakeMessage: huge backlog stays under maxBytes; long messages truncated", () => {
  const big = "x".repeat(200_000);
  const addressed = Array.from({ length: 50 }, () => msg("B", `@A ${big}`));
  const other = Array.from({ length: 500 }, () => msg("C", big));
  for (const maxBytes of [4096, 16384]) {
    const w = buildWakeMessage({ addressed, other, droppedEarlier: 300, recentK: 10, maxBytes, header: "H" });
    assert.ok(bytes(w.content) <= maxBytes, `${bytes(w.content)} <= ${maxBytes}`);
    assert.ok(w.shownAddressed >= 1);
    assert.match(w.content, /truncated/);
    assert.match(w.content, /earlier addressed message\(s\) omitted/);
    assert.equal(w.omitted, 50 - w.shownAddressed + 500 - w.shownOther + 300);
  }
});

test("WakeBudget: burst, refill, hourly cap pause, quiet resume, manual resume", () => {
  let now = 0;
  const b = new WakeBudget({ burst: 3, refillPerMinute: 1, hourlyCap: 5, quietResumeMinutes: 10 }, () => now);
  for (let i = 0; i < 3; i++) assert.deepEqual(b.tryWake(), { allowed: true });
  const t = b.tryWake();
  assert.equal(t.allowed, false);
  assert.equal(t.allowed === false && t.reason, "throttled");
  assert.ok(t.allowed === false && t.reason === "throttled" && t.retryInMs === 60_000);
  now += 60_000;
  assert.deepEqual(b.tryWake(), { allowed: true });
  now += 60_000;
  assert.deepEqual(b.tryWake(), { allowed: true }); // 5 wakes this hour
  now += 120_000;
  b.noteAddressed();
  assert.deepEqual(b.tryWake(), { allowed: false, reason: "paused", justPaused: true });
  assert.deepEqual(b.tryWake(), { allowed: false, reason: "paused", justPaused: false });
  assert.equal(b.state().paused, true);
  now += 5 * 60_000;
  assert.equal(b.noteAddressed(), false, "not quiet long enough");
  now += 9 * 60_000;
  assert.equal(b.noteAddressed(), false, "the previous message reset the quiet timer");
  now += 10 * 60_000;
  assert.equal(b.noteAddressed(), true, "quiet resume");
  assert.deepEqual(b.tryWake(), { allowed: true });
  // Manual resume.
  for (let i = 0; i < 2; i++) b.tryWake();
  now += 3 * 60_000;
  for (let i = 0; i < 3; i++) b.tryWake();
  assert.equal(b.state().paused, true);
  b.resume();
  assert.equal(b.state().paused, false);
  assert.equal(b.state().wakesLastHour, 0);
  assert.deepEqual(b.tryWake(), { allowed: true });
});

test("WakeBudget: rolling hour forgets old wakes", () => {
  let now = 0;
  const b = new WakeBudget({ burst: 100, refillPerMinute: 100, hourlyCap: 2, quietResumeMinutes: 10 }, () => now);
  b.tryWake();
  b.tryWake();
  now += 3_600_001;
  assert.deepEqual(b.tryWake(), { allowed: true });
});

test("Inbox: addressed wakes, others are recorded and delivered once as context", () => {
  let now = 0;
  const st = state("A");
  const ib = new Inbox(prof(), st, () => now);
  assert.equal(ib.add([msg("B", "chat 1"), msg("C", "/react 1 👍"), msg("B", "chat 2")]), false);
  assert.equal(ib.attempt("H").kind, "none");
  assert.equal(ib.unseenCount, 3);
  assert.equal(ib.add([msg("B", "@A your turn")]), true);
  const a = ib.attempt("H");
  assert.equal(a.kind, "wake");
  if (a.kind !== "wake") return;
  assert.equal(a.addressed, 1);
  assert.equal(a.other, 3);
  assert.match(a.content, /@A your turn/);
  assert.match(a.content, /chat 2/);
  assert.equal(ib.unseenCount, 0);
  assert.equal(ib.attempt("H").kind, "none");
});

test("Inbox: /re to our message wakes; own seqs are live", () => {
  const own = new Set<number>();
  const ib = new Inbox(prof(), { name: "A", ownSeqs: own });
  assert.equal(ib.add([msg("B", "/re 7 ok")]), false);
  own.add(8);
  assert.equal(ib.add([msg("B", "/re 8 ok")]), true);
});

test("Inbox: throttled wake is retried, then includes everything", () => {
  let now = 0;
  const ib = new Inbox(prof({ budget: { burst: 1, refillPerMinute: 1 } }), state(), () => now);
  ib.add([msg("B", "@A first")]);
  assert.equal(ib.attempt("H").kind, "wake");
  ib.add([msg("B", "@A second"), msg("C", "aside")]);
  const t = ib.attempt("H");
  assert.equal(t.kind, "throttled");
  ib.add([msg("B", "@A third")]);
  now += 60_000;
  const w = ib.attempt("H");
  assert.equal(w.kind, "wake");
  if (w.kind === "wake") {
    assert.equal(w.addressed, 2);
    assert.match(w.content, /second[\s\S]*third/);
    assert.match(w.content, /aside/);
  }
});

test("Inbox: hard cap pauses once, resume() re-enables", () => {
  let now = 0;
  const ib = new Inbox(prof({ budget: { burst: 100, refillPerMinute: 100, hourlyCap: 2 } }), state(), () => now);
  for (let i = 0; i < 2; i++) {
    ib.add([msg("B", "@A ping")]);
    assert.equal(ib.attempt("H").kind, "wake");
  }
  ib.add([msg("B", "@A ping")]);
  assert.deepEqual(ib.attempt("H"), { kind: "paused", justPaused: true });
  ib.add([msg("B", "@A ping again")]);
  assert.deepEqual(ib.attempt("H"), { kind: "paused", justPaused: false });
  ib.resume();
  const w = ib.attempt("H");
  assert.equal(w.kind, "wake");
  if (w.kind === "wake") assert.equal(w.addressed, 2);
});

test("Inbox: wake=all wakes on any message; wake=none never, but read(unread) works", () => {
  const all = new Inbox(prof({ wake: "all" }), state());
  assert.equal(all.add([msg("B", "plain")]), true);
  const a = all.attempt("H");
  assert.equal(a.kind, "wake");
  if (a.kind === "wake") assert.match(a.content, /New messages:\n.*plain/);

  const none = new Inbox(prof({ wake: "none" }), state());
  assert.equal(none.add([msg("B", "@A hi"), msg("C", "plain")]), false);
  assert.equal(none.attempt("H").kind, "none");
  const r = none.take("H");
  assert.equal(r.shownAddressed, 1);
  assert.equal(r.shownOther, 1);
  assert.equal(none.unseenCount, 0);
});

test("Inbox: unseen buffer is bounded and counts drops; resume backlog yields one capped message", () => {
  const ib = new Inbox(prof(), state());
  const backlog = Array.from({ length: 500 }, (_, i) => msg("B", `m${i} ` + "y".repeat(2000)));
  backlog.push(msg("C", "@A wake up"));
  assert.equal(ib.add(backlog), true);
  assert.equal(ib.unseen.length, UNSEEN_MAX);
  assert.equal(ib.dropped, 500 - UNSEEN_MAX);
  const w = ib.attempt("H");
  assert.equal(w.kind, "wake");
  if (w.kind === "wake") {
    assert.ok(bytes(w.content) <= 16384);
    assert.ok(w.other >= 5 && w.other <= 10, `other=${w.other}`); // K=10, but the 16 KB cap binds first
    assert.equal(w.omitted, 500 - w.other);
    assert.match(w.content, new RegExp(`${500 - w.other} earlier message\\(s\\) omitted`));
    assert.match(w.content, /m499 /);
  }
});

test("Inbox: markSeen drops only the range read", () => {
  const ib = new Inbox(prof(), state());
  ib.add([msg("B", "a", 1), msg("B", "b", 2), msg("B", "c", 3)]);
  ib.markSeen(2, 3);
  assert.deepEqual(ib.unseen.map((m) => m.seq), [1]);
});
