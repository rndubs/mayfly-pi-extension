import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInterrupt } from "../mayfly-core.ts";
import { decideWake, Inbox, stopTargetsMe, WakeBudget } from "../policy.ts";
import { mergeProfile, validateProfile } from "../profile.ts";
import {
  busyNoticeText,
  BusyTracker,
  describeReceipts,
  formatDuration,
  isReceiptChatter,
  parseBusyNotice,
  parseReact,
  ReactionQueue,
  ReceiptTracker,
  resolveTargets,
  ackText,
  backoffDelay,
  noReceiptsExpected,
  parseAck,
} from "../receipts.ts";

const msg = (from: string, text: string, seq = 1) => ({ seq, ts: "t", src: "s", from, text });
const state = (name = "A", own: number[] = []) => ({ name, ownSeqs: new Set(own) });

test("parseInterrupt: names, quoted names, groups, all; message optional", () => {
  assert.deepEqual(parseInterrupt("/interrupt A stop editing foo.ts"), { target: "A", message: "stop editing foo.ts" });
  assert.deepEqual(parseInterrupt('/interrupt "Pi Bot" the API changed'), { target: "Pi Bot", message: "the API changed" });
  assert.deepEqual(parseInterrupt("/interrupt @reviewers look now"), { target: "reviewers", message: "look now" });
  assert.deepEqual(parseInterrupt("/interrupt all"), { target: "all", message: undefined });
  assert.deepEqual(parseInterrupt("/INTERRUPT A multi\nline"), { target: "A", message: "multi\nline" });
  assert.equal(parseInterrupt("/interrupt"), null);
  assert.equal(parseInterrupt("please /interrupt A"), null);
  assert.equal(parseInterrupt("/interrupted A"), null);
  assert.equal(stopTargetsMe(parseInterrupt('/interrupt "pi bot" x')!.target, "Pi Bot"), true);
});

test("decideWake: /interrupt is handled by the watcher, never addressed", () => {
  const d = decideWake(msg("H", "/interrupt A @A now"), state(), mergeProfile());
  assert.equal(d.wake, false);
  assert.equal(decideWake(msg("H", "/interrupt A now"), state(), mergeProfile({ wake: "all" })).wake, false);
});

test("decideWake: reactions never address; receipts and busy notices don't wake under wake=all", () => {
  const all = mergeProfile({ wake: "all" });
  const addr = mergeProfile();
  assert.equal(decideWake(msg("B", "/react 5 📬"), state("A", [5]), addr).wake, false);
  assert.equal(decideWake(msg("B", "/react 5 👀"), state("A", [5]), addr).wake, false);
  assert.equal(decideWake(msg("B", "/react 5 📬"), state("A", [5]), all).wake, false);
  assert.equal(decideWake(msg("B", "/react 5 👀"), state("A", [5]), all).wake, false);
  assert.equal(decideWake(msg("B", "/unreact 5 👀"), state("A", [5]), all).wake, false);
  assert.equal(decideWake(msg("B", busyNoticeText("B", 5, "bash", 400_000)), state("A", [5]), all).wake, false);
  // Other reactions still wake under wake=all (unchanged), and ordinary chatter too.
  assert.equal(decideWake(msg("B", "/react 5 👍"), state("A", [5]), all).wake, true);
  assert.equal(decideWake(msg("B", "hello"), state("A"), all).wake, true);
});

test("busy notice: plain names only, so it addresses nobody, and it parses back", () => {
  const t = busyNoticeText("Pi Bot", 41, "bash", 6 * 60_000 + 5_000);
  assert.equal(t, '⏳ Pi Bot got #41 but is busy (bash, running 6m). It will read it after the current step; /interrupt "Pi Bot" <message> to break in.');
  assert.ok(!t.includes("@"));
  assert.deepEqual(parseBusyNotice(t), { name: "Pi Bot", seq: 41, tool: "bash", running: "6m" });
  assert.equal(isReceiptChatter(t), true);
  const p = mergeProfile({ wake: "addressed", requireAtForMention: false });
  // Even with bare-name mentions on, the notice wakes nobody but its own author (whose own messages never wake it).
  assert.equal(decideWake(msg("Pi Bot", t), state("H", [41]), p).wake, false);
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(65 * 60_000), "1h 5m");
});

test("parseReact", () => {
  assert.deepEqual(parseReact("/react 12 👀"), { seq: 12, emoji: "👀", un: false });
  assert.deepEqual(parseReact("/unreact 3 📬"), { seq: 3, emoji: "📬", un: true });
  assert.equal(parseReact("/react x 👀"), null);
});

test("BusyTracker: one notice per sender per tool call, above the threshold; reset when the tool or run ends", () => {
  let now = 0;
  const b = new BusyTracker(() => now);
  assert.equal(b.check("H", 1, "A", 30_000), null, "nothing running");
  b.toolStart("t1", "bash");
  now = 10_000;
  assert.equal(b.check("H", 1, "A", 30_000), null, "below threshold");
  now = 31_000;
  assert.match(b.check("H", 2, "A", 30_000)!, /^⏳ A got #2 but is busy \(bash, running 31s\)/);
  assert.equal(b.check("H", 3, "A", 30_000), null, "same sender, same busy period");
  assert.equal(b.check("h", 3, "A", 30_000), null, "case-insensitive");
  assert.ok(b.check("G", 4, "A", 30_000), "another sender gets its own notice");
  b.toolEnd("t1");
  assert.equal(b.check("H", 5, "A", 30_000), null, "idle again");
  b.toolStart("t2", "edit");
  now = 70_000;
  assert.match(b.check("H", 6, "A", 30_000)!, /edit, running 39s/, "new busy period");
  b.runEnd();
  assert.equal(b.current(), null);
});

test("ReactionQueue: one 📬 and one 👀 per seq, sequential, 👀 supersedes a queued 📬", async () => {
  const sent: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const q = new ReactionQueue(async (seq, emoji) => {
    sent.push(`${seq}${emoji}`);
    if (sent.length === 1) await gate;
    return true;
  });
  assert.equal(q.enqueue(1, "📬"), true); // in flight
  assert.equal(q.enqueue(1, "📬"), false);
  q.enqueue(2, "📬"); // queued
  q.enqueue(3, "📬"); // queued
  q.enqueue(2, "👀"); // drops the queued 📬 for #2
  q.enqueue(2, "👀");
  q.enqueue(1, "👀");
  release();
  await q.idle();
  assert.deepEqual(sent, ["1📬", "3📬", "2👀", "1👀"]);
  q.remember("9:👀");
  assert.equal(q.enqueue(9, "👀"), false, "remembered from history");
});

test("resolveTargets: @names (incl. spaces), /re author; @all and known groups are broadcasts", () => {
  const known = ["A", "B", "Pi Bot", "Pi", "H"];
  const groups = ["reviewers"];
  assert.deepEqual(resolveTargets("@B please check", known, "A"), { names: ["B"], broadcast: false });
  assert.deepEqual(resolveTargets("@Pi Bot and @B", known, "A"), { names: ["Pi Bot", "B"], broadcast: false });
  assert.deepEqual(resolveTargets("@Pi only", known, "A"), { names: ["Pi"], broadcast: false });
  assert.deepEqual(resolveTargets("@all status?", known, "A"), { names: [], broadcast: true });
  assert.deepEqual(resolveTargets("@reviewers look", known, "A", undefined, groups), { names: [], broadcast: true, groups: ["reviewers"] });
  assert.deepEqual(resolveTargets("@B and @reviewers", known, "A", undefined, groups), { names: ["B"], broadcast: true, groups: ["reviewers"] });
  // An @tag that is neither a known name nor a known group: wait for that exact name, not for anyone.
  assert.deepEqual(resolveTargets("@Carol can you help", known, "A"), { names: ["Carol"], broadcast: false, unseen: ["Carol"] });
  assert.deepEqual(resolveTargets("@reviewers look", known, "A"), { names: ["reviewers"], broadcast: false, unseen: ["reviewers"] });
  assert.deepEqual(resolveTargets("@ALL hands", known, "A"), { names: [], broadcast: true });
  assert.deepEqual(resolveTargets("thanks", known, "A", "H"), { names: ["H"], broadcast: false });
  assert.equal(resolveTargets("just chatting, mail b@B.com", known, "A"), null);
  assert.equal(resolveTargets("note to self @A", known, "A"), null);
});

test("ReceiptTracker: which reactions count, per target", () => {
  let now = 1000;
  const t = new ReceiptTracker(200, () => now);
  t.noteOwn(10, "@B @C do it", { names: ["B", "C"], broadcast: false });
  assert.equal(t.noteReaction("B", 10, "👍"), false, "other emoji ignored");
  now = 1800;
  t.noteReaction("B", 10, "📬");
  assert.equal(ReceiptTracker.satisfied(t.get(10)!, "received"), false, "C missing");
  t.noteReaction("c", 10, "👀"); // 👀 implies received; names are case-insensitive
  assert.equal(ReceiptTracker.satisfied(t.get(10)!, "received"), true);
  assert.equal(ReceiptTracker.satisfied(t.get(10)!, "seen"), false, "B hasn't seen it");
  assert.deepEqual(
    t.missing().map((m) => [m.rec.seq, m.noReceived, m.noSeen]),
    [[10, [], ["B"]]],
  );
  // @all / @group only: no receipts are expected, so nothing satisfies it and it isn't listed as missing.
  t.noteOwn(11, "@all hi", { names: [], broadcast: true });
  t.noteReaction("Z", 11, "📬");
  assert.equal(ReceiptTracker.satisfied(t.get(11)!, "received"), false);
  assert.deepEqual(t.missing().map((m) => m.rec.seq), [10]);
  // Bounded.
  const small = new ReceiptTracker(3);
  for (let s = 1; s <= 5; s++) small.noteOwn(s, "x", null);
  assert.deepEqual(small.recent(10).map((r) => r.seq), [5, 4, 3]);
});

test("ReceiptTracker.wait: resolves on the receipt, times out, or aborts", async () => {
  const t = new ReceiptTracker();
  t.noteOwn(1, "@B hi", { names: ["B"], broadcast: false });
  const w = t.wait(1, "received", 5000);
  setTimeout(() => t.noteReaction("B", 1, "📬"), 20);
  assert.equal((await w).satisfied, true);
  const w2 = await t.wait(1, "seen", 50);
  assert.deepEqual([w2.satisfied, w2.aborted], [false, false]);
  const ac = new AbortController();
  const w3 = t.wait(1, "seen", 5000, ac.signal);
  ac.abort();
  assert.deepEqual([(await w3).satisfied, (await w3).aborted], [false, true]);
});

test("ReceiptTracker.wait received: lingers briefly for a busy notice after the 📬, ends early on busy or 👀", async () => {
  const t = new ReceiptTracker();
  t.noteOwn(1, "@B hi", { names: ["B"], broadcast: false });
  const w = t.wait(1, "received", 5000, undefined, 2000);
  let done = false;
  void w.then(() => (done = true));
  t.noteReaction("B", 1, "📬");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(done, false, "still in the busy grace");
  t.noteBusy("B", 1, "bash", "56s");
  const r = await w;
  assert.equal(r.satisfied, true);
  assert.equal(r.record.busy[0].tool, "bash");
  // No busy notice: the grace runs out and the wait is still satisfied.
  t.noteOwn(2, "@B again", { names: ["B"], broadcast: false });
  const w2 = t.wait(2, "received", 5000, undefined, 40);
  t.noteReaction("B", 2, "📬");
  assert.equal((await w2).satisfied, true);
  // Already seen: no grace at all.
  t.noteOwn(3, "@B more", { names: ["B"], broadcast: false });
  t.noteReaction("B", 3, "👀");
  const start = Date.now();
  assert.equal((await t.wait(3, "received", 5000, undefined, 2000)).satisfied, true);
  assert.ok(Date.now() - start < 500);
});

test("describeReceipts", () => {
  let now = 0;
  const t = new ReceiptTracker(200, () => now);
  t.noteOwn(41, "@B go", { names: ["B"], broadcast: false });
  assert.match(describeReceipts(t.get(41)!, { level: "seen", waitedSec: 60 }), /^no 📬 within 60s from B — the recipient may not be running/);
  now = 800;
  t.noteReaction("B", 41, "📬");
  t.noteBusy("B", 41, "bash", "6m");
  assert.equal(describeReceipts(t.get(41)!, { level: "seen", waitedSec: 60 }), "📬 B after 0.8s; no 👀 within 60s; B said it is busy (bash, 6m)");
  now = 34_000;
  t.noteReaction("B", 41, "👀");
  assert.equal(describeReceipts(t.get(41)!, { level: "seen", waitedSec: 60 }), "📬 B after 0.8s; 👀 B after 34s; B said it is busy (bash, 6m)");
});

test("WakeBudget.forceWake bypasses the throttle and a pause but counts toward the hourly cap", () => {
  let now = 0;
  const b = new WakeBudget({ burst: 1, refillPerMinute: 0, hourlyCap: 2, quietResumeMinutes: 10, interruptsPerHour: 6 }, () => now);
  assert.equal(b.tryWake().allowed, true);
  assert.equal(b.tryWake().allowed, false, "throttled");
  b.forceWake();
  assert.equal(b.state().wakesLastHour, 2);
  const r = b.tryWake();
  assert.equal(r.allowed, false);
  assert.equal(!r.allowed && r.reason, "paused", "the forced wake counted toward the cap");
  b.forceWake(); // still allowed while paused
  assert.equal(b.state().wakesLastHour, 3);
});

test("Inbox.attemptUrgent delivers the interrupt first, with what's buffered; requeue puts a lost wake back", () => {
  const p = mergeProfile({ budget: { burst: 1, refillPerMinute: 0, hourlyCap: 1 } });
  const inbox = new Inbox(p, state("A"));
  inbox.add([msg("H", "@A first", 1)]);
  const w = inbox.attempt("hdr");
  assert.equal(w.kind, "wake");
  inbox.add([msg("H", "@A second", 2), msg("H", "chatter", 3)]);
  assert.equal(inbox.attempt("hdr").kind, "paused");
  const u = inbox.attemptUrgent("hdr", msg("H", "/interrupt A stop", 4), "H interrupted your current work");
  assert.match(u.content, /H interrupted your current work/);
  assert.match(u.content, /\/interrupt A stop/);
  assert.match(u.content, /@A second/);
  assert.deepEqual(u.addressedSeqs, [2, 4]);
  assert.equal(inbox.unseenCount, 0);
  inbox.requeue(u.taken);
  assert.equal(inbox.pending.length, 2);
  assert.equal(inbox.wantsWake(), false, "requeued messages are held, not woken for");
  assert.equal(inbox.hasHeld, true);
});

test("profile: receipts and busyNoticeAfterSec", () => {
  assert.equal(mergeProfile().receipts, true);
  assert.equal(mergeProfile().busyNoticeAfterSec, 30);
  assert.deepEqual(validateProfile({ receipts: false, busyNoticeAfterSec: false }), { receipts: false, busyNoticeAfterSec: false });
  assert.equal(mergeProfile(validateProfile({ busyNoticeAfterSec: 5 })).busyNoticeAfterSec, 5);
  assert.throws(() => validateProfile({ receipts: "yes" }), /receipts: must be true or false/);
  assert.throws(() => validateProfile({ busyNoticeAfterSec: -1 }), /busyNoticeAfterSec/);
  assert.throws(() => validateProfile({ busyNoticeAfterSec: true }), /busyNoticeAfterSec/);
});

test("ReceiptTracker: an unseen @name is waited for exactly; someone else's receipt doesn't satisfy it", () => {
  let t = 1000;
  const tr = new ReceiptTracker(200, () => t);
  tr.noteOwn(5, "@Carol help", resolveTargets("@Carol help", ["A", "B"], "A"));
  t = 1500;
  tr.noteReaction("B", 5, "📬");
  const rec = tr.get(5)!;
  assert.equal(ReceiptTracker.satisfied(rec, "received"), false);
  assert.match(describeReceipts(rec), /waiting for exact name Carol \(not seen in this channel yet\)/);
  tr.noteReaction("Carol", 5, "📬");
  assert.equal(ReceiptTracker.satisfied(tr.get(5)!, "received"), true);
});

test("receipts only for direct addressing: @all/@group expect none; mixed targets wait for the names", () => {
  const tr = new ReceiptTracker(200, () => 0);
  const g = resolveTargets("@reviewers look", ["A"], "A", undefined, ["reviewers"]);
  assert.match(noReceiptsExpected(g)!, /only sent for direct @name or reply addressing, and this message addresses only @reviewers/);
  assert.match(noReceiptsExpected(resolveTargets("@all hi", ["A"], "A"))!, /addresses only @all/);
  assert.match(noReceiptsExpected(null)!, /addresses nobody/);
  tr.noteOwn(6, "@reviewers look", g);
  assert.match(describeReceipts(tr.get(6)!), /no receipts expected/);
  const mixed = resolveTargets("@B and @all", ["A", "B"], "A")!;
  assert.equal(noReceiptsExpected(mixed), null);
  tr.noteOwn(7, "@B and @all", mixed);
  tr.noteReaction("C", 7, "📬");
  assert.equal(ReceiptTracker.satisfied(tr.get(7)!, "received"), false, "C (an @all member) doesn't count");
  tr.noteReaction("B", 7, "📬");
  assert.equal(ReceiptTracker.satisfied(tr.get(7)!, "received"), true);
  assert.match(describeReceipts(tr.get(7)!), /@all members send no receipts/);
});

test("resolveTargets: a name with spaces is only recognized after it has posted; we don't guess", () => {
  // Before "Pi Bot" has posted, "@Pi Bot" reads as the exact name "Pi" (documented), and says so when waiting.
  const before = resolveTargets("@Pi Bot please check", ["A"], "A");
  assert.deepEqual(before, { names: ["Pi"], broadcast: false, unseen: ["Pi"] });
  const tr = new ReceiptTracker(200, () => 0);
  tr.noteOwn(8, "@Pi Bot please check", before);
  assert.match(describeReceipts(tr.get(8)!), /waiting for exact name Pi \(not seen in this channel yet\) — a name with spaces is only recognized once that participant has posted/);
  // Once it has posted (e.g. its join intro), the full name wins over a shorter known prefix.
  assert.deepEqual(resolveTargets("@Pi Bot please check", ["A", "Pi", "Pi Bot"], "A"), { names: ["Pi Bot"], broadcast: false });
});

test("ReceiptTracker.cancelWaits resolves pending waits as not satisfied and clears their timers", async () => {
  const t = new ReceiptTracker();
  t.noteOwn(1, "@B hi", { names: ["B"], broadcast: false });
  const w = t.wait(1, "received", 60_000);
  assert.equal(t.waiting, 1);
  t.cancelWaits("left the channel");
  const r = await w;
  assert.deepEqual([r.satisfied, r.aborted, r.cancelled], [false, false, "left the channel"]);
  assert.equal(t.waiting, 0);
});

test("backoffDelay: jittered, exponential from ~200 ms, capped at 5 s", () => {
  assert.equal(backoffDelay(0, () => 0), 100);
  assert.equal(backoffDelay(0, () => 1), 200);
  assert.equal(backoffDelay(3, () => 1), 1600);
  assert.equal(backoffDelay(10, () => 1), 5000);
  assert.equal(backoffDelay(50, () => 0), 2500);
});

test("ReactionQueue: a reaction is done only once posted; a failed one can be queued again; uncertain counts as done", async () => {
  const sent: string[] = [];
  const outcomes: (boolean | null)[] = [false, true, null];
  const q = new ReactionQueue(async (seq, emoji) => {
    sent.push(`${seq}${emoji}`);
    return outcomes.shift()!;
  });
  q.enqueue(1, "📬");
  await q.idle();
  assert.equal(q.has(1, "📬"), false, "gave up: not done");
  assert.equal(q.enqueue(1, "📬"), true, "can be queued again");
  await q.idle();
  assert.equal(q.has(1, "📬"), true);
  assert.equal(q.enqueue(1, "📬"), false, "at most once");
  q.enqueue(2, "👀");
  await q.idle();
  assert.equal(q.has(2, "👀"), true, "uncertain: never retried, so never doubled");
  assert.equal(q.enqueue(2, "👀"), false);
  assert.deepEqual(sent, ["1📬", "1📬", "2👀"]);
});

test("acks: non-waking text, parseable, counted as receipt chatter", () => {
  const t = ackText("⚡", "B", "interrupted (was running bash, 6m) — handling it", { seq: 41, from: "@A" });
  assert.equal(t, "⚡ B interrupted (was running bash, 6m) — handling it (#41 from A)");
  assert.doesNotMatch(t, /@|^\/re /);
  assert.deepEqual(parseAck(t), { kind: "⚡", name: "B", seq: 41, from: "A" });
  assert.equal(isReceiptChatter(t), true);
  assert.equal(isReceiptChatter(ackText("⏹", "B", "stopped (running work aborted)", { seq: 2, from: "H" })), true);
  assert.equal(isReceiptChatter("⚡ big news everyone"), false);
});
