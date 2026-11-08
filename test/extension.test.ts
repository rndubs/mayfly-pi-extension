// Extension wiring (index.ts) against a real local Mayfly server, with a fake Pi API.
// Skipped unless a server binary is available: $MAYFLY_SERVER_BIN or `mayfly` on PATH.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Channel, createChannel, openChannel } from "../mayfly-core.ts";
import { findServerBin, type LocalServer, startServer } from "./mayfly-server.ts";

// index.ts imports its siblings as "./x.js" (for the build); map those to the .ts sources here.
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith(".") && spec.endsWith(".js") && ctx.parentURL?.endsWith(".ts")) {
      try {
        return next(spec.slice(0, -3) + ".ts", ctx);
      } catch {}
    }
    return next(spec, ctx);
  },
});

const bin = findServerBin();
if (!bin && process.env.MAYFLY_REQUIRE_SERVER) throw new Error("MAYFLY_REQUIRE_SERVER is set but no Mayfly server binary was found");
const skip = bin ? false : "no Mayfly server binary: set MAYFLY_SERVER_BIN or put `mayfly` on PATH";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(pred: () => boolean, ms: number, what: string) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await sleep(50);
  }
}

type Entry = { type: "custom"; customType: string; data: any };

/** A minimal fake of the Pi extension API: records sendMessage calls and session entries. */
async function makePi(branch: Entry[] = []) {
  const { default: ext } = await import("../index.ts");
  const tools: Record<string, any> = {};
  const handlers: Record<string, ((e: unknown, ctx: unknown) => Promise<void>)[]> = {};
  const cmds: Record<string, any> = {};
  const sent: { m: any; o: any }[] = [];
  const notes: string[] = [];
  let idle = true;
  let abortMakesIdle = true;
  let aborts = 0;
  const pi: any = {
    on: (ev: string, h: any) => (handlers[ev] ??= []).push(h),
    registerTool: (t: any) => (tools[t.name] = t),
    registerCommand: (n: string, c: any) => (cmds[n] = c),
    sendMessage: (m: any, o: any) => sent.push({ m, o }),
    appendEntry: (customType: string, data: any) => branch.push({ type: "custom", customType, data }),
  };
  const ctx: any = {
    cwd: process.cwd(),
    hasUI: true,
    isIdle: () => idle,
    abort: () => {
      aborts++;
      if (abortMakesIdle) idle = true;
    },
    ui: { notify: (t: string) => notes.push(t), setStatus: () => {} },
    sessionManager: { getBranch: () => branch },
  };
  ext(pi);
  /** Fire an event; returns the handlers' results (e.g. before_agent_start's { message }). */
  const fire = async (ev: string, payload: unknown = {}) => {
    const out: any[] = [];
    for (const h of handlers[ev] ?? []) out.push(await h(payload, ctx));
    return out.filter((x) => x !== undefined);
  };
  await fire("session_start");
  return {
    sent,
    notes,
    branch,
    wakes: () => sent.filter((s) => s.m.customType === "mayfly"),
    stops: () => sent.filter((s) => s.m.customType === "mayfly-stop"),
    setIdle: (v: boolean) => (idle = v),
    setAbortMakesIdle: (v: boolean) => (abortMakesIdle = v),
    aborts: () => aborts,
    fire,
    /** What Pi does when an injected message enters the model's context. */
    emitMessageStart: (m: any) => fire("message_start", { type: "message_start", message: { role: "custom", ...m, timestamp: Date.now() } }),
    command: (args: string) => cmds.mayfly.handler(args, ctx),
    call: (name: string, params: any, signal?: AbortSignal) => tools[name].execute("id", params, signal, undefined, ctx),
    shutdown: () => fire("session_shutdown"),
  };
}

describe("extension wiring against a local Mayfly server", { skip }, () => {
  let srv: LocalServer;
  let dir: string;
  const cleanup: (() => unknown)[] = [];
  before(async () => {
    srv = await startServer(bin!);
    dir = mkdtempSync(join(tmpdir(), "mayfly-ext-test-"));
  });
  after(async () => {
    for (const f of cleanup.reverse()) await f();
    await srv?.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  /** A raw client. Its post() retries on a conflict (the agent's receipts often land first), and fails loudly. */
  const open = (url: string, name: string): Channel => {
    const ch = openChannel(url, name);
    cleanup.push(() => ch.close());
    const post = ch.post.bind(ch);
    ch.post = async (text, opts) => {
      for (let i = 0; i < 10; i++) {
        const r = await post(text, opts);
        if (r.posted === true) return r;
        if (!r.conflict) throw new Error(`post failed: ${r.error}`);
      }
      throw new Error("post kept conflicting");
    };
    return ch;
  };
  const pi = async (branch?: Entry[]) => {
    const p = await makePi(branch);
    cleanup.push(() => p.shutdown());
    return p;
  };
  const profileFile = (name: string, body: object) => {
    const path = join(dir, `${name}.json`);
    writeFileSync(path, JSON.stringify(body));
    return path;
  };

  test("resume: a /re to our message posted while Pi was closed wakes us", async () => {
    // The watcher's first resumed batch used to be classified before history() had filled ownSeqs.
    for (let trial = 0; trial < 3; trial++) {
      const { url, id } = await createChannel(srv.origin);
      const a1 = openChannel(url, "A");
      const r = await a1.post("my work is done");
      const last = a1.last;
      a1.close();
      await open(url, "H").post(`/re ${r.id} can you also fix Y?`);
      const P = await pi([
        { type: "custom", customType: "mayfly-join", data: { url, name: "A" } },
        { type: "custom", customType: "mayfly-cursor", data: { last, id } },
      ]);
      await until(() => P.wakes().length === 1, 8000, `trial ${trial}: a wake for the /re`);
      assert.match(P.wakes()[0].m.content, /can you also fix Y\?/);
      await P.shutdown();
    }
  });

  test("cursor: a later join never resumes from another channel's cursor; a matching cursor resumes", async () => {
    const a = await createChannel(srv.origin);
    const b = await createChannel(srv.origin);
    const h = open(b.url, "H");
    for (let i = 0; i < 8; i++) await h.post(i === 6 ? "@A old request" : `chatter ${i}`);
    // Channel A's cursor (5) followed by a join of B: B must start at its head, not replay from #6.
    const P1 = await pi([
      { type: "custom", customType: "mayfly-join", data: { url: a.url, name: "A" } },
      { type: "custom", customType: "mayfly-cursor", data: { last: 5 } }, // legacy entry without id
      { type: "custom", customType: "mayfly-join", data: { url: b.url, name: "A" } },
    ]);
    // A cursor stored with another channel's id is ignored too.
    const P2 = await pi([
      { type: "custom", customType: "mayfly-join", data: { url: b.url, name: "A" } },
      { type: "custom", customType: "mayfly-cursor", data: { last: 5, id: a.id } },
    ]);
    // A cursor for this channel resumes from it.
    const P3 = await pi([
      { type: "custom", customType: "mayfly-join", data: { url: b.url, name: "A" } },
      { type: "custom", customType: "mayfly-cursor", data: { last: 5, id: b.id } },
    ]);
    await until(() => P3.wakes().length === 1, 8000, "the resumed wake");
    assert.match(P3.wakes()[0].m.content, /@A old request/);
    await sleep(500);
    assert.equal(P1.wakes().length, 0);
    assert.equal(P2.wakes().length, 0);
  });

  test("a /stop that isn't allowed doesn't cancel a pending (throttled) wake", async () => {
    const { url } = await createChannel(srv.origin);
    const fast = profileFile("fast", { budget: { burst: 1, refillPerMinute: 20 } }); // retry after 3 s
    const P = await pi();
    await P.command(`join ${url} A --profile=${fast} --no-stop -- testing`);
    const h = open(url, "H");
    await sleep(300);
    await h.post("@A task 0");
    await until(() => P.wakes().length === 1, 3000, "first wake");
    await h.post("@A task 1"); // throttled: retry scheduled
    await sleep(400);
    await h.post("/stop A");
    await until(() => P.wakes().length === 2, 6000, "the throttled wake despite the disallowed /stop");
    assert.match(P.wakes()[1].m.content, /task 1/);
    assert.equal(P.stops().length, 0);
    const hist = await h.history(10);
    assert.ok(hist.some((m) => m.from === "A" && /^⛔ A is ignoring it — that sender is not allowed to stop \(#\d+ from H\)$/.test(m.text)));
  });

  test("an allowed /stop still cancels the pending wake", async () => {
    const { url } = await createChannel(srv.origin);
    const fast = profileFile("fast2", { budget: { burst: 1, refillPerMinute: 20 } });
    const P = await pi();
    await P.command(`join ${url} A --profile=${fast} -- testing`);
    const h = open(url, "H");
    await sleep(300);
    await h.post("@A task 0");
    await until(() => P.wakes().length === 1, 3000, "first wake");
    await h.post("@A task 1");
    await sleep(400);
    await h.post("/stop A");
    await until(() => P.stops().length === 1, 3000, "the stop note");
    await sleep(3500);
    assert.equal(P.wakes().length, 1);
  });

  test("a budget pause resumes by itself after the quiet period and delivers what was held", async () => {
    const { url } = await createChannel(srv.origin);
    const paused = profileFile("pause", { budget: { burst: 6, hourlyCap: 1, quietResumeMinutes: 0.05 } }); // 3 s
    const P = await pi();
    await P.command(`join ${url} A --profile=${paused} -- testing`);
    const h = open(url, "H");
    await sleep(300);
    await h.post("@A one");
    await until(() => P.wakes().length === 1, 3000, "first wake");
    await h.post("@A two (held)");
    await h.post("chatter while paused");
    await until(() => P.notes.some((n) => /auto-wake paused/.test(n)), 3000, "the pause");
    assert.equal(P.wakes().length, 1);
    await until(() => P.wakes().length === 2, 6000, "the wake after quiet resume");
    const w = P.wakes()[1].m.content;
    assert.match(w, /two \(held\)/);
    assert.match(w, /chatter while paused/);
    assert.match(w, /has now resumed/);
  });

  test("a /stop handled while busy does nothing more once the channel is left", async () => {
    const { url } = await createChannel(srv.origin);
    const P = await pi();
    await P.command(`join ${url} A -- testing`);
    const h = open(url, "H");
    await sleep(300);
    P.setIdle(false);
    P.setAbortMakesIdle(false); // the aborted run takes a while to settle
    await h.post("/stop A");
    await until(() => P.notes.some((n) => /stopped by H/.test(n)), 3000, "the stop");
    await P.call("mayfly_leave", {});
    P.setIdle(true);
    await sleep(800);
    assert.equal(P.stops().length, 0, "no stop note after leaving");
    const hist = await h.history(10);
    assert.ok(!hist.some((m) => m.text.startsWith("⏹")), "no ⏹ reply after leaving");
  });

  // --- v0.5: steer, receipts, busy notice, /interrupt ---------------------------------

  const reactsBy = (msgs: { from: string; text: string }[], who: string, seq: number, emoji: string) =>
    msgs.filter((m) => m.from === who && m.text === `/react ${seq} ${emoji}`).length;

  test("addressed: 📬 at once while busy, steered delivery, 👀 only when the injection reaches the model", async () => {
    const { url } = await createChannel(srv.origin);
    const P = await pi();
    await P.command(`join ${url} A -- testing`);
    const h = open(url, "H");
    await sleep(300);
    P.setIdle(false);
    const r = await h.post("@A please look at this");
    await until(() => P.wakes().length === 1, 3000, "the wake");
    const w = P.wakes()[0];
    assert.deepEqual(w.o, { triggerTurn: true, deliverAs: "steer" });
    assert.deepEqual(w.m.details.addressed, [r.id]);
    let hist: { from: string; text: string }[] = [];
    for (let i = 0; i < 30 && reactsBy(hist, "A", r.id!, "📬") < 1; i++) {
      await sleep(100);
      hist = await h.history(20);
    }
    assert.equal(reactsBy(hist, "A", r.id!, "📬"), 1);
    await sleep(500);
    hist = await h.history(20);
    assert.equal(reactsBy(hist, "A", r.id!, "👀"), 0, "no 👀 before the model has it");
    await P.emitMessageStart(w.m);
    await P.emitMessageStart(w.m); // a repeat doesn't post twice
    for (let i = 0; i < 30 && reactsBy(hist, "A", r.id!, "👀") < 1; i++) {
      await sleep(100);
      hist = await h.history(20);
    }
    await sleep(300);
    hist = await h.history(20);
    assert.equal(reactsBy(hist, "A", r.id!, "👀"), 1);
    assert.equal(reactsBy(hist, "A", r.id!, "📬"), 1);
  });

  test("idle delivery triggers a turn without deliverAs; plain chat gets no receipts; receipts=false posts none", async () => {
    const { url } = await createChannel(srv.origin);
    const P = await pi();
    await P.command(`join ${url} A -- testing`);
    const off = profileFile("noreceipts", { receipts: false });
    const Q = await pi();
    await Q.command(`join ${url} Q --profile=${off} -- testing`);
    const h = open(url, "H");
    await sleep(300);
    await h.post("just chatting, nobody in particular");
    const r = await h.post("@A @Q ping");
    await until(() => P.wakes().length === 1 && Q.wakes().length === 1, 3000, "the wakes");
    assert.deepEqual(P.wakes()[0].o, { triggerTurn: true });
    await P.emitMessageStart(P.wakes()[0].m);
    await Q.emitMessageStart(Q.wakes()[0].m);
    await sleep(1200);
    const hist = await h.history(30);
    const reacts = hist.filter((m) => m.text.startsWith("/react "));
    // A: 📬 (possibly superseded by 👀 if not yet sent) and 👀 for #r only; Q: nothing; the chatter: nothing.
    assert.ok(reacts.every((m) => m.from === "A" && m.text.startsWith(`/react ${r.id} `)), JSON.stringify(reacts));
    assert.equal(reactsBy(hist, "A", r.id!, "👀"), 1);
  });

  test("waitFor: received resolves with the receipt; seen times out cleanly", async () => {
    const { url } = await createChannel(srv.origin);
    const A = await pi();
    await A.command(`join ${url} A -- testing`);
    const B = await pi();
    await B.command(`join ${url} B -- testing`);
    await sleep(500);
    B.setIdle(false); // B is busy: it receives (📬) but its model doesn't see it
    const t0 = Date.now();
    const res = await A.call("mayfly_post", { text: "@B can you check the build?", waitFor: "received", timeoutSec: 10 });
    const out = res.content[0].text;
    assert.match(out, /^Posted #\d+\. 📬 B after \d+(\.\d)?s/, out);
    assert.ok(Date.now() - t0 < 8000);
    const res2 = await A.call("mayfly_post", { text: "@B and this one?", waitFor: "seen", timeoutSec: 1 });
    const out2 = res2.content[0].text;
    assert.match(out2, /📬 B after/, out2);
    assert.match(out2, /no 👀 within 1s/, out2);
    assert.equal(res2.isError, false, "a timeout is not an error");
    // Status lists what is still missing a 👀.
    const st = (await A.call("mayfly_status", {})).content[0].text;
    assert.match(st, /awaiting receipts:/);
    assert.match(st, /no 👀 from B/);
    const rc = (await A.call("mayfly_receipts", {})).content[0].text;
    assert.match(rc, /📬 B after/);
    // Nobody running: no 📬 at all.
    const res3 = await A.call("mayfly_post", { text: "@Ghost hello?", waitFor: "received", timeoutSec: 1 });
    // @Ghost has never posted: we wait for that exact name (not anyone), and say so.
    assert.match(res3.content[0].text, /no 📬 within 1s from Ghost — the recipient may not be running/);
    assert.match(res3.content[0].text, /waiting for exact name Ghost \(not seen in this channel yet\)/);
  });

  test("busy notice: posted once per sender while one tool call runs past the threshold", async () => {
    const { url } = await createChannel(srv.origin);
    const fast = profileFile("busy", { busyNoticeAfterSec: 0.2 });
    const P = await pi();
    await P.command(`join ${url} A --profile=${fast} -- testing`);
    const h = open(url, "H");
    const g = open(url, "G");
    await sleep(300);
    P.setIdle(false);
    await P.fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: {} });
    await sleep(400);
    await h.post("@A one");
    await sleep(400);
    await h.post("@A two");
    await g.post("@A from G");
    await sleep(1500);
    let notices = (await h.history(30)).filter((m) => m.text.startsWith("⏳"));
    assert.equal(notices.length, 2, JSON.stringify(notices));
    assert.match(notices[0].text, /^⏳ A got #\d+ but is busy \(bash, running \d+s\)\. It will read it after the current step; \/interrupt A <message> to break in\.$/);
    assert.ok(notices.every((n) => !n.text.includes("@")));
    // The tool ends and a new one starts: a new busy period.
    await P.fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: {}, isError: false });
    await P.fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "c2", toolName: "edit", args: {} });
    await sleep(400);
    await h.post("@A three");
    await sleep(1200);
    notices = (await h.history(40)).filter((m) => m.text.startsWith("⏳"));
    assert.equal(notices.length, 3);
    assert.match(notices[2].text, /\(edit, running/);
  });

  test("/interrupt while busy: aborts, then wakes with triggerTurn and a resume note; ⚡ reply", async () => {
    const { url } = await createChannel(srv.origin);
    const P = await pi();
    await P.command(`join ${url} A -- testing`);
    const h = open(url, "H");
    await sleep(300);
    P.setIdle(false);
    await P.fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: {} });
    const r = await h.post("/interrupt A the API changed, stop editing client.ts");
    await until(() => P.wakes().length === 1, 4000, "the urgent wake");
    assert.equal(P.aborts(), 1);
    const w = P.wakes()[0];
    assert.equal(w.o.triggerTurn, true);
    assert.match(w.m.content, /H interrupted your current work via Mayfly \(#\d+\): the API changed, stop editing client\.ts/);
    assert.match(w.m.content, /Decide whether to resume the interrupted work/);
    assert.deepEqual(w.m.details.addressed, [r.id]);
    await P.emitMessageStart(w.m);
    let hist: { from: string; text: string }[] = [];
    for (let i = 0; i < 30; i++) {
      hist = await h.history(20);
      if (hist.some((m) => m.text.includes("⚡")) && reactsBy(hist, "A", r.id!, "👀")) break;
      await sleep(100);
    }
    assert.ok(hist.some((m) => m.from === "A" && new RegExp(`^⚡ A interrupted \\(was running bash, \\d+s\\) — handling it \\(#${r.id} from H\\)$`).test(m.text)), JSON.stringify(hist));
    assert.equal(reactsBy(hist, "A", r.id!, "👀"), 1);
    assert.equal(P.stops().length, 0);
  });

  test("/interrupt while idle: a normal wake, even when the budget is paused; mayfly_interrupt quotes names", async () => {
    const { url } = await createChannel(srv.origin);
    const paused = profileFile("pause2", { budget: { hourlyCap: 1, quietResumeMinutes: 60 } });
    const P = await pi();
    await P.command(`join ${url} Pi Bot --profile=${paused} -- testing`);
    const S = await pi();
    await S.command(`join ${url} S -- testing`);
    const h = open(url, "H");
    await sleep(400);
    await h.post("@Pi Bot one");
    await until(() => P.wakes().length === 1, 3000, "first wake");
    await h.post("@Pi Bot two (held)");
    await until(() => P.notes.some((n) => /auto-wake paused/.test(n)), 3000, "the pause");
    let res: any;
    for (let i = 0; i < 5; i++) {
      res = await S.call("mayfly_interrupt", { target: "Pi Bot", message: "urgent: check prod" });
      if (!/^Conflict/.test(res.content[0].text)) break; // a real agent would reconsider and retry too
    }
    assert.equal(res.isError, false, res.content[0].text);
    await until(() => P.wakes().length === 2, 4000, "the urgent wake despite the pause");
    assert.equal(P.aborts(), 0);
    const w = P.wakes()[1];
    assert.deepEqual(w.o, { triggerTurn: true });
    assert.match(w.m.content, /S sent you an urgent message via Mayfly \(#\d+\): urgent: check prod/);
    assert.match(w.m.content, /two \(held\)/);
    const hist = await h.history(20);
    assert.ok(hist.some((m) => m.from === "S" && m.text === '/interrupt "Pi Bot" urgent: check prod'));
    for (let i = 0; i < 30 && !(await h.history(20)).some((m) => /^⚡ Pi Bot was idle — handling it \(#\d+ from /.test(m.text)); i++) await sleep(100);
    assert.ok((await h.history(20)).some((m) => /^⚡ Pi Bot was idle — handling it \(#\d+ from /.test(m.text)));
  });

  test("a disallowed /interrupt doesn't abort or cancel a pending (throttled) wake", async () => {
    const { url } = await createChannel(srv.origin);
    const fast = profileFile("fast3", { budget: { burst: 1, refillPerMinute: 20 } });
    const P = await pi();
    await P.command(`join ${url} A --profile=${fast} --no-stop -- testing`);
    const h = open(url, "H");
    await sleep(300);
    await h.post("@A task 0");
    await until(() => P.wakes().length === 1, 3000, "first wake");
    P.setIdle(false);
    await h.post("@A task 1"); // throttled: retry scheduled
    await sleep(400);
    await h.post("/interrupt A drop everything");
    await until(() => P.wakes().length === 2, 6000, "the throttled wake despite the disallowed /interrupt");
    assert.equal(P.aborts(), 0);
    assert.match(P.wakes()[1].m.content, /task 1/);
    assert.doesNotMatch(P.wakes()[1].m.content, /interrupted your current work/);
    const hist = await h.history(20);
    assert.ok(hist.some((m) => m.from === "A" && /^⛔ A is ignoring it — that sender is not allowed to interrupt \(#\d+ from H\)$/.test(m.text)));
    assert.equal(reactsBy(hist, "A", hist.find((m) => m.text.startsWith("/interrupt"))!.seq, "📬"), 0, "no receipt for a disallowed interrupt");
  });

  test("a steered wake lost to an abort is held, not redelivered; it comes with the next addressed message", async () => {
    const { url } = await createChannel(srv.origin);
    const P = await pi();
    await P.command(`join ${url} A -- testing`);
    const h = open(url, "H");
    await sleep(300);
    P.setIdle(false);
    await h.post("@A important");
    await until(() => P.wakes().length === 1, 3000, "the steered wake");
    // The run is aborted (Esc) before the steer is processed (no message_start), then ends.
    P.setIdle(true);
    await P.fire("agent_end", { type: "agent_end", messages: [] });
    await sleep(2500);
    assert.equal(P.wakes().length, 1, "an aborted run never restarts by itself");
    assert.match((await P.call("mayfly_status", {})).content[0].text, /held: /);
    await h.post("@A next thing");
    await until(() => P.wakes().length === 2, 3000, "the next addressed wake");
    assert.match(P.wakes()[1].m.content, /@A important/);
    assert.match(P.wakes()[1].m.content, /@A next thing/);
    await P.emitMessageStart(P.wakes()[1].m);
    await P.fire("agent_end", { type: "agent_end", messages: [] });
    await sleep(1500);
    assert.equal(P.wakes().length, 2, "a seen wake is not redelivered");
  });

  test("held messages ride along with the user's next prompt (before_agent_start), once", async () => {
    const { url } = await createChannel(srv.origin);
    const P = await pi();
    await P.command(`join ${url} A -- testing`);
    const h = open(url, "H");
    await sleep(300);
    P.setIdle(false);
    await h.post("@A important");
    await until(() => P.wakes().length === 1, 3000, "the steered wake");
    P.setIdle(true);
    await P.fire("agent_end", { type: "agent_end", messages: [] });
    await sleep(1300);
    // Our own custom-message runs bring nothing.
    assert.deepEqual(await P.fire("before_agent_start", { type: "before_agent_start", messageType: "custom", message: {} }), []);
    const [r] = await P.fire("before_agent_start", { type: "before_agent_start", messageType: "user", prompt: "carry on" });
    assert.equal(r.message.customType, "mayfly");
    assert.match(r.message.content, /@A important/);
    assert.match(r.message.content, /Held after your previous run/);
    assert.deepEqual(await P.fire("before_agent_start", { type: "before_agent_start", messageType: "user", prompt: "again" }), []);
    // In RPC mode Pi may still deliver the stale steer: its seqs leave the inbox, so nothing is shown twice later.
    await P.emitMessageStart(r.message);
    await sleep(1000);
    assert.equal(P.wakes().length, 1, "no auto-wake");
  });

  test("RPC: a stale steer Pi kept after the abort removes its messages from the inbox when it arrives", async () => {
    const { url } = await createChannel(srv.origin);
    const P = await pi();
    await P.command(`join ${url} A -- testing`);
    const h = open(url, "H");
    await sleep(300);
    P.setIdle(false);
    await h.post("@A important");
    await until(() => P.wakes().length === 1, 3000, "the steered wake");
    P.setIdle(true);
    await P.fire("agent_end", { type: "agent_end", messages: [] });
    await sleep(1300); // requeued (held)
    await P.emitMessageStart(P.wakes()[0].m); // Pi delivers the stale steer in the next run after all
    await h.post("@A next");
    await until(() => P.wakes().length === 2, 3000, "the next wake");
    assert.doesNotMatch(P.wakes()[1].m.content, /@A important/, "not shown twice");
  });

  test("/interrupt over the per-sender limit: no abort, an ordinary addressed wake, and a ⛔ notice", async () => {
    const { url } = await createChannel(srv.origin);
    const lim = profileFile("intlimit", { budget: { interruptsPerHour: 1 } });
    const P = await pi();
    await P.command(`join ${url} A --profile=${lim} -- testing`);
    const h = open(url, "H");
    await sleep(300);
    P.setIdle(false);
    await h.post("/interrupt A first");
    await until(() => P.wakes().length === 1, 4000, "the urgent wake");
    assert.equal(P.aborts(), 1);
    P.setIdle(false);
    const r2 = await h.post("/interrupt A second");
    await until(() => P.wakes().length === 2, 4000, "the ordinary wake");
    assert.equal(P.aborts(), 1, "no abort over the limit");
    const w = P.wakes()[1];
    assert.deepEqual(w.o, { triggerTurn: true, deliverAs: "steer" });
    assert.match(w.m.content, /\/interrupt A second/);
    assert.doesNotMatch(w.m.content, /interrupted your current work/);
    let hist: { from: string; text: string }[] = [];
    for (let i = 0; i < 30 && !hist.some((m) => m.text.startsWith("⛔")); i++) {
      await sleep(100);
      hist = await h.history(20);
    }
    assert.ok(hist.some((m) => m.from === "A" && m.text === `⛔ A is treating it as a normal message — interrupt limit reached (#${r2.id} from H)`), JSON.stringify(hist));
  });

  test("waitFor on an @all or group-only message returns at once; mixed targets wait only for the names", async () => {
    const { url } = await createChannel(srv.origin);
    const A = await pi();
    await A.command(`join ${url} A -- testing`);
    const B = await pi();
    await B.command(`join ${url} B -- testing`);
    await sleep(500);
    const t0 = Date.now();
    const res = await A.call("mayfly_post", { text: "@all status?", waitFor: "received", timeoutSec: 30 });
    assert.ok(Date.now() - t0 < 3000);
    assert.match(res.content[0].text, /^Posted #\d+\. Not waiting: receipts are only sent for direct @name or reply addressing, and this message addresses only @all\./);
    const res2 = await A.call("mayfly_post", { text: "@all and @B: check", waitFor: "received", timeoutSec: 10 });
    assert.match(res2.content[0].text, /📬 B after/);
    assert.match(res2.content[0].text, /@all members send no receipts/);
  });

  test("leaving ends a pending waitFor at once", async () => {
    const { url } = await createChannel(srv.origin);
    const A = await pi();
    await A.command(`join ${url} A -- testing`);
    await sleep(300);
    const pending = A.call("mayfly_post", { text: "@Ghost hello?", waitFor: "received", timeoutSec: 60 });
    await sleep(500);
    const t0 = Date.now();
    await A.call("mayfly_leave", {});
    const res = await pending;
    assert.ok(Date.now() - t0 < 2000);
    assert.match(res.content[0].text, /wait cancelled: left the channel/);
  });

  // --- review regressions (PR #5) ------------------------------------------------------

  test("R1: a 409 caused by a real message the watcher already delivered is surfaced, not auto-retried", async () => {
    const { url } = await createChannel(srv.origin);
    const P = await pi();
    await P.command(`join ${url} A -- testing`);
    const h = open(url, "H");
    await sleep(500);
    const realFetch = globalThis.fetch;
    let delayNext = true;
    globalThis.fetch = (async (u: any, init: any) => {
      if (init?.method === "POST" && delayNext && String(u).includes("last=")) {
        delayNext = false;
        await sleep(800); // A's POST is in flight (stale cursor) while H's message lands and the watcher delivers it
      }
      return realFetch(u, init);
    }) as any;
    let res: any;
    try {
      const pending = P.call("mayfly_post", { text: "deploying now" });
      await sleep(50);
      await h.post("WAIT do not deploy, prod is on fire");
      res = await pending;
    } finally {
      globalThis.fetch = realFetch;
    }
    const out = res.content[0].text;
    assert.match(out, /^Conflict/, out);
    assert.match(out, /WAIT do not deploy, prod is on fire/, out);
    assert.equal(res.isError, true);
    const hist = await h.history(10);
    assert.ok(!hist.some((m) => m.from === "A" && m.text === "deploying now"), "the post went out without the model seeing the conflicting message");
  });

  test("R2: with bare-name mentions on, a ⚡ ack naming us doesn't wake us", async () => {
    const { url } = await createChannel(srv.origin);
    const bare = profileFile("bare", { requireAtForMention: false });
    const A = await pi();
    await A.command(`join ${url} A --profile=${bare} -- testing`);
    const B = await pi();
    await B.command(`join ${url} B -- testing`);
    await sleep(500);
    let res: any;
    for (let i = 0; i < 5; i++) {
      res = await A.call("mayfly_interrupt", { target: "B", message: "check prod" });
      if (!/^Conflict/.test(res.content[0].text)) break;
    }
    await until(() => B.wakes().length === 1, 4000, "B's urgent wake");
    const h = open(url, "H");
    for (let i = 0; i < 40 && !(await h.history(20)).some((m) => m.text.startsWith("⚡ B")); i++) await sleep(100);
    await sleep(1000);
    assert.equal(A.wakes().length, 0, "the ack woke the interrupter");
  });

  test("R3: after /stop, a receipt reaction from someone else doesn't start a turn", async () => {
    const { url } = await createChannel(srv.origin);
    const P = await pi();
    await P.command(`join ${url} A -- testing`);
    const h = open(url, "H");
    await sleep(300);
    P.setIdle(false);
    const r = await h.post("@A do the thing");
    await until(() => P.wakes().length === 1, 3000, "steered wake");
    await sleep(100);
    await h.post("/stop A");
    await until(() => P.stops().length === 1, 4000, "stop handled");
    await P.fire("agent_end", { type: "agent_end", messages: [] });
    await sleep(1600);
    assert.equal(P.wakes().length, 1, "held after the stop");
    await h.post(`/react ${r.id} 📬`);
    await sleep(1500);
    assert.equal(P.wakes().length, 1, "a receipt reaction started a turn after /stop");
  });

  test("R4: eight agents, one burst of direct @name messages: every 📬 arrives; @all gets no receipts", async () => {
    const { url } = await createChannel(srv.origin);
    const names = ["A", "B", "C", "D", "E", "F", "G", "I"];
    for (const n of names) await (await pi()).command(`join ${url} ${n} -- testing`);
    const h = open(url, "H");
    await sleep(1500);
    const seqs: Record<string, number> = {};
    for (const n of names) seqs[n] = (await h.post(`@${n} task for ${n}`)).id!;
    let missing = names;
    for (let i = 0; i < 120 && missing.length; i++) {
      await sleep(250);
      const hist = await h.history(300);
      missing = names.filter((n) => reactsBy(hist, n, seqs[n], "📬") + reactsBy(hist, n, seqs[n], "👀") === 0);
    }
    assert.deepEqual(missing, [], "missing 📬");
    const all = await h.post("@all status check");
    await sleep(3000);
    const hist = await h.history(300);
    const got = hist.filter((m) => m.text === `/react ${all.id} 📬` || m.text === `/react ${all.id} 👀`);
    assert.deepEqual(got.map((m) => m.from), [], "@all must not get receipts");
  });
});
