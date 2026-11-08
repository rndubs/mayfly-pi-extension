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
      if (abortMakesIdle) idle = true;
    },
    ui: { notify: (t: string) => notes.push(t), setStatus: () => {} },
    sessionManager: { getBranch: () => branch },
  };
  ext(pi);
  const fire = async (ev: string) => {
    for (const h of handlers[ev] ?? []) await h({}, ctx);
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
    command: (args: string) => cmds.mayfly.handler(args, ctx),
    call: (name: string, params: any) => tools[name].execute("id", params, undefined, undefined, ctx),
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
  const open = (url: string, name: string): Channel => {
    const ch = openChannel(url, name);
    cleanup.push(() => ch.close());
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
    assert.ok(hist.some((m) => m.from === "A" && /⛔ ignoring \/stop from "H"/.test(m.text)));
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
});
