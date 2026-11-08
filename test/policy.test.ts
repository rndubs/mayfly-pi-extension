import { test } from "node:test";
import assert from "node:assert/strict";
import type { MayflyMessage } from "../mayfly-core.ts";
import { parseStop } from "../mayfly-core.ts";
import {
  addressedReason,
  buildWakeMessage,
  decideWake,
  directReason,
  Inbox,
  InterruptLimiter,
  targetsMeByName,
  mentions,
  parseReplyTarget,
  stopTargetsMe,
  TRUST_NOTE,
  truncateBytes,
  PENDING_MAX,
  UNSEEN_MAX,
  WakeBudget,
} from "../policy.ts";
import { mergeProfile, validateProfile } from "../profile.ts";

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

test("mentions: a name continues through - and _; @-suffixes and emails don't match", () => {
  assert.equal(mentions("@code-bot please run", "code"), false);
  assert.equal(mentions("@code_bot please run", "code"), false);
  assert.equal(mentions("@code-bot please run", "code-bot"), true);
  assert.equal(mentions("@all-hands meeting", "all"), false);
  assert.equal(mentions("@rev-team look", "rev"), false);
  assert.equal(mentions("@Pi.dev is a site", "Pi"), false);
  assert.equal(mentions("mail bob@example.com", "bob", false), false);
  assert.equal(mentions("@bob@example.com", "bob"), false);
  assert.equal(mentions("set up pi-hole", "Pi", false), false);
  assert.equal(mentions("x-bob said", "bob", false), false);
  // Ordinary punctuation still ends a mention.
  for (const t of ["thanks @Pi.", "@Pi, look", "@Pi: look", "(@Pi)", "@Pi!", "@Pi? ok", "@Pi's turn"]) assert.equal(mentions(t, "Pi"), true, t);
  assert.equal(mentions("bob, look", "bob", false), true);
  assert.equal(mentions("@Pi Bot hi", "Pi Bot"), true);
});

test("decideWake: @all-hands and @rev-team don't wake @all or group rev", () => {
  const p = prof({ groups: ["rev"] });
  assert.equal(decideWake(msg("H", "@all-hands meeting"), state("A"), p).wake, false);
  assert.equal(decideWake(msg("H", "@rev-team look"), state("A"), p).wake, false);
  assert.equal(decideWake(msg("H", "@code-bot run"), state("code"), p).wake, false);
  assert.equal(decideWake(msg("H", "@rev look"), state("A"), p).wake, true);
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
  const b = new WakeBudget({ burst: 3, refillPerMinute: 1, hourlyCap: 5, quietResumeMinutes: 10, interruptsPerHour: 6 }, () => now);
  for (let i = 0; i < 3; i++) assert.deepEqual(b.tryWake(), { allowed: true, resumed: false });
  const t = b.tryWake();
  assert.equal(t.allowed, false);
  assert.equal(t.allowed === false && t.reason, "throttled");
  assert.ok(t.allowed === false && t.reason === "throttled" && t.retryInMs === 60_000);
  now += 60_000;
  assert.deepEqual(b.tryWake(), { allowed: true, resumed: false });
  now += 60_000;
  assert.deepEqual(b.tryWake(), { allowed: true, resumed: false }); // 5 wakes this hour
  now += 120_000;
  b.noteAddressed();
  assert.deepEqual(b.tryWake(), { allowed: false, reason: "paused", justPaused: true, retryInMs: 600_000 });
  assert.deepEqual(b.tryWake(), { allowed: false, reason: "paused", justPaused: false, retryInMs: 600_000 });
  assert.equal(b.state().paused, true);
  now += 5 * 60_000;
  assert.equal(b.noteAddressed(), false, "not quiet long enough");
  now += 9 * 60_000;
  assert.equal(b.noteAddressed(), false, "the previous message reset the quiet timer");
  now += 10 * 60_000;
  assert.equal(b.noteAddressed(), true, "quiet resume");
  assert.deepEqual(b.tryWake(), { allowed: true, resumed: false });
  // Manual resume.
  for (let i = 0; i < 2; i++) b.tryWake();
  now += 3 * 60_000;
  for (let i = 0; i < 3; i++) b.tryWake();
  assert.equal(b.state().paused, true);
  b.resume();
  assert.equal(b.state().paused, false);
  assert.equal(b.state().wakesLastHour, 0);
  assert.deepEqual(b.tryWake(), { allowed: true, resumed: false });
});

test("WakeBudget: a pause reports when quiet resume is possible and resumes on the next try", () => {
  let now = 0;
  const b = new WakeBudget({ burst: 100, refillPerMinute: 100, hourlyCap: 1, quietResumeMinutes: 10, interruptsPerHour: 6 }, () => now);
  b.noteAddressed();
  assert.deepEqual(b.tryWake(), { allowed: true, resumed: false });
  now += 60_000;
  b.noteAddressed();
  assert.deepEqual(b.tryWake(), { allowed: false, reason: "paused", justPaused: true, retryInMs: 600_000 });
  assert.equal(b.resumeAt, 660_000);
  now += 4 * 60_000;
  assert.equal(b.msUntilResume(), 360_000);
  assert.deepEqual(b.tryWake(), { allowed: false, reason: "paused", justPaused: false, retryInMs: 360_000 });
  now += 6 * 60_000;
  assert.equal(b.msUntilResume(), 0);
  assert.deepEqual(b.tryWake(), { allowed: true, resumed: true });
  assert.equal(b.isPaused, false);
  assert.equal(b.resumeAt, undefined);
});

test("WakeBudget: rolling hour forgets old wakes", () => {
  let now = 0;
  const b = new WakeBudget({ burst: 100, refillPerMinute: 100, hourlyCap: 2, quietResumeMinutes: 10, interruptsPerHour: 6 }, () => now);
  b.tryWake();
  b.tryWake();
  now += 3_600_001;
  assert.deepEqual(b.tryWake(), { allowed: true, resumed: false });
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
  assert.deepEqual(ib.attempt("H"), { kind: "paused", justPaused: true, retryInMs: 600_000 });
  ib.add([msg("B", "@A ping again")]);
  assert.deepEqual(ib.attempt("H"), { kind: "paused", justPaused: false, retryInMs: 600_000 });
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

test("Inbox: a budget pause resumes after the quiet period and delivers what was held", () => {
  let now = 0;
  const ib = new Inbox(prof({ budget: { hourlyCap: 2, burst: 6, quietResumeMinutes: 10 } }), state(), () => now);
  for (let i = 0; i < 2; i++) {
    ib.add([msg("H", `@A go ${i}`)]);
    assert.equal(ib.attempt("h").kind, "wake");
    now += 1000;
  }
  ib.add([msg("H", "@A held"), msg("H", "chatter")]);
  const p = ib.attempt("h");
  assert.equal(p.kind, "paused");
  // The caller schedules a retry for when quiet resume is possible.
  assert.ok(p.kind === "paused" && p.justPaused && p.retryInMs === 600_000);
  now += 600_000;
  const w = ib.attempt("h");
  assert.equal(w.kind, "wake");
  if (w.kind === "wake") {
    assert.equal(w.resumed, true);
    assert.match(w.content, /has now resumed/);
    assert.match(w.content, /@A held/);
    assert.match(w.content, /chatter/);
  }
  assert.equal(ib.budget.isPaused, false);
  assert.equal(ib.unseenCount, 0);
});

test("Inbox: addressed buffer is bounded; drops are counted in the omitted note", () => {
  const ib = new Inbox(prof({ wake: "none" }), state());
  for (let i = 0; i < PENDING_MAX + 50; i++) ib.add([msg("H", `@all ping ${i}`, 10_000 + i)]);
  assert.equal(ib.pending.length, PENDING_MAX);
  assert.equal(ib.droppedAddressed, 50);
  assert.equal(ib.pending[0].text, "@all ping 50", "newest kept");
  assert.equal(ib.unseenCount, PENDING_MAX + 50);
  const r = ib.take("H");
  assert.equal(r.omitted, PENDING_MAX + 50 - r.shownAddressed);
  assert.match(r.content, new RegExp(`Addressed to you \\(${PENDING_MAX + 50}\\)`));
  assert.match(r.content, new RegExp(`${PENDING_MAX + 50 - r.shownAddressed} earlier addressed message\\(s\\) omitted`));
  assert.equal(ib.unseenCount, 0);
});

test("Inbox: markSeen of the addressed messages leaves no wake owed for chatter", () => {
  const ib = new Inbox(prof(), state());
  ib.add([msg("H", "chatter", 10)]);
  assert.equal(ib.add([msg("H", "@A do x", 50)]), true);
  ib.markSeen(31, 50);
  assert.equal(ib.wantsWake(), false);
  assert.equal(ib.attempt("h").kind, "none");
  assert.equal(ib.unseenCount, 1, "chatter is still recorded");
  // An addressed message outside the range keeps the wake owed.
  const ib2 = new Inbox(prof(), state());
  ib2.add([msg("H", "@A one", 10), msg("H", "@A two", 50)]);
  ib2.markSeen(31, 50);
  assert.equal(ib2.wantsWake(), true);
  // wake=all: anything left keeps it owed.
  const ib3 = new Inbox(prof({ wake: "all" }), state());
  ib3.add([msg("H", "a", 10), msg("H", "b", 50)]);
  ib3.markSeen(31, 50);
  assert.equal(ib3.wantsWake(), true);
  ib3.markSeen(0, 30);
  assert.equal(ib3.wantsWake(), false);
});

test("buildWakeMessage: a line exactly as long as the remaining room is shown truncated, not dropped", () => {
  const header = "H";
  const footer = "F";
  const maxBytes = 700;
  const room = maxBytes - (bytes([header, TRUST_NOTE].join("\n")) + bytes(footer) + 400);
  assert.ok(room > 100 && room < 256, `room=${room}`);
  const prefix = "[#7 B] ";
  const m = { seq: 7, ts: "t", src: "s", from: "B", text: "x".repeat(room - bytes(prefix)) };
  const w = buildWakeMessage({ addressed: [m], other: [], recentK: 10, maxBytes, header, footer });
  assert.equal(w.shownAddressed, 1);
  assert.equal(w.omitted, 0);
  assert.match(w.content, /\[#7 B\] x+ … \[truncated/);
  assert.ok(bytes(w.content) <= maxBytes);
});

// --- review regressions (PR #5) -----------------------------------------------------

test("R2: acks, busy notices and receipts are never addressed, even with bare-name mentions on", () => {
  const p = prof({ requireAtForMention: false });
  const ack = msg("B", "⚡ B was idle — handling it (#41 from A)");
  const busy = msg("B", "⏳ B got #41 but is busy (bash, running 6m). It will read it after the current step; /interrupt B <message> to break in.");
  for (const m of [ack, busy, msg("B", "/react 41 📬")]) {
    assert.equal(addressedReason(m, state("A"), p), null, m.text);
    assert.equal(decideWake(m, state("A"), p).wake, false, m.text);
    assert.equal(decideWake(m, state("A"), { ...p, wake: "all" }).wake, false, m.text);
  }
  // A plain message naming A still counts with bare-name mentions on.
  assert.equal(decideWake(msg("B", "A, can you look?"), state("A"), p).wake, true);
  // The inbox classifies the same way: the ack is recorded as unseen, not pending, and owes no wake.
  const ib = new Inbox(p, state("A"));
  assert.equal(ib.add([ack]), false);
  assert.deepEqual([ib.pending.length, ib.unseen.length], [0, 1]);
});

test("directReason: @name, /re to our message, bare name only if enabled; not @all or @group", () => {
  const p = prof({ groups: ["rev"] });
  assert.match(directReason(msg("H", "@A go"), state("A"), p)!, /mentions @A/);
  assert.match(directReason(msg("H", "/re 7 thanks"), state("A", [7]), p)!, /reply to our #7/);
  assert.equal(directReason(msg("H", "@all go"), state("A"), p), null);
  assert.equal(directReason(msg("H", "@rev go"), state("A"), p), null);
  assert.ok(addressedReason(msg("H", "@rev go"), state("A"), p), "still addressed (wakes)");
  assert.equal(directReason(msg("H", "A go"), state("A"), p), null);
  assert.ok(directReason(msg("H", "A go"), state("A"), prof({ requireAtForMention: false })));
  assert.equal(targetsMeByName("A", "a"), true);
  assert.equal(targetsMeByName("all", "A"), false);
});

test("R3 (unit): a batch only asks for a wake if it brings something waking; held messages wait", () => {
  const ib = new Inbox(prof(), state("A"));
  ib.add([msg("H", "@A do the thing", 1)]);
  ib.hold(); // a /stop arrived
  assert.equal(ib.wantsWake(), false);
  assert.equal(ib.hasHeld, true);
  assert.equal(ib.add([msg("H", "/react 1 📬", 2)]), false, "a receipt never wakes");
  assert.equal(ib.add([msg("H", "plain chatter", 3)]), false);
  assert.equal(ib.attempt("h").kind, "none");
  // A genuinely new addressed message wakes, and the held one rides along.
  assert.equal(ib.add([msg("H", "@A next", 4)]), true);
  const w = ib.attempt("h");
  assert.equal(w.kind, "wake");
  if (w.kind === "wake") {
    assert.match(w.content, /do the thing/);
    assert.match(w.content, /@A next/);
  }
  assert.equal(ib.hasHeld, false);
});

test("Inbox.requeue: held, no wake owed; drop counts restored; release / takeHeld deliver it", () => {
  const ib = new Inbox(prof({ wake: "none" }), state("A"));
  for (let i = 0; i < PENDING_MAX + 5; i++) ib.add([msg("H", `@A n${i}`, 1000 + i)]);
  ib.setProfile(prof());
  ib.add([msg("H", "@A last", 5000)]);
  const w = ib.attempt("h");
  assert.equal(w.kind, "wake");
  if (w.kind !== "wake") return;
  assert.equal(w.taken.droppedAddressed, 6);
  ib.add([msg("H", "chatter after", 6000)]);
  ib.requeue(w.taken);
  assert.equal(ib.wantsWake(), false);
  assert.equal(ib.hasHeld, true);
  assert.equal(ib.droppedAddressed, 6, "drop count restored");
  assert.equal(ib.unseenCount, PENDING_MAX + 6 + 1);
  assert.equal(ib.pending.at(-1)!.text, "@A last");
  // A user turn takes what is held (no budget).
  const h = ib.takeHeld("h", ["note"]);
  assert.ok(h);
  assert.match(h!.content, /6 earlier addressed message\(s\) omitted|earlier addressed message\(s\) omitted/);
  assert.equal(ib.takeHeld("h"), null);
  // release() (mayfly_resume) owes the wake again.
  ib.add([msg("H", "@A x", 7000)]);
  ib.attempt("h");
  const w2 = ib.attempt("h");
  assert.equal(w2.kind, "none");
  ib.requeue({ addressed: [msg("H", "@A lost", 7001)], other: [] });
  assert.equal(ib.wantsWake(), false);
  assert.equal(ib.release(), true);
  // forgetSeqs (the stale steer reached the model after all) clears it.
  ib.forgetSeqs([7001]);
  assert.equal(ib.wantsWake(), false);
  assert.equal(ib.unseenCount, 0);
});

test("Inbox: under wake=all, markSeen/forget leave no wake owed when only chatter remains", () => {
  const ib = new Inbox(prof({ wake: "all" }), state("A"));
  ib.add([msg("B", "/react 3 📬", 10), msg("B", "⚡ B was idle — handling it (#3 from H)", 11), msg("H", "real", 12)]);
  assert.equal(ib.wantsWake(), true);
  ib.markSeen(12, 12);
  assert.equal(ib.wantsWake(), false, "only chatter left");
  assert.equal(ib.unseenCount, 2);
});

test("InterruptLimiter: per sender, rolling hour (fake clock)", () => {
  let now = 0;
  const l = new InterruptLimiter(2, () => now);
  assert.equal(l.tryInterrupt("A"), true);
  now += 1000;
  assert.equal(l.tryInterrupt("a"), true, "case-insensitive");
  assert.equal(l.tryInterrupt("A"), false, "over the limit");
  assert.equal(l.tryInterrupt("B"), true, "per sender");
  assert.equal(l.used("A"), 2);
  now = 3_600_001; // the first one left the window
  assert.equal(l.tryInterrupt("A"), true);
  assert.equal(l.tryInterrupt("A"), false);
  const zero = new InterruptLimiter(0, () => now);
  assert.equal(zero.tryInterrupt("A"), false, "0 disables urgent interrupts");
});

test("Inbox.addAddressed: a downgraded interrupt wakes normally, but not under wake=none", () => {
  const ib = new Inbox(prof(), state("A"));
  assert.equal(ib.addAddressed([msg("H", "/interrupt A stop", 1)]), true);
  const w = ib.attempt("h");
  assert.ok(w.kind === "wake" && /\/interrupt A stop/.test(w.content));
  const none = new Inbox(prof({ wake: "none" }), state("A"));
  assert.equal(none.addAddressed([msg("H", "/interrupt A stop", 1)]), false);
  assert.equal(none.pending.length, 1);
});

test("profile: budget.interruptsPerHour (default 6), validated", () => {
  assert.equal(mergeProfile().budget.interruptsPerHour, 6);
  assert.equal(mergeProfile(validateProfile({ budget: { interruptsPerHour: 0 } })).budget.interruptsPerHour, 0);
  assert.throws(() => validateProfile({ budget: { interruptsPerHour: 1.5 } }), /budget\.interruptsPerHour: must be an integer >= 0/);
  assert.throws(() => validateProfile({ budget: { interruptsPerHour: -1 } }), /interruptsPerHour/);
});
