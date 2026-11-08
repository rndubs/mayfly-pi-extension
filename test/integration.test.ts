// Integration tests for mayfly-core against a real local Mayfly server.
// Skipped (with a message) unless a server binary is available: $MAYFLY_SERVER_BIN or `mayfly` on PATH.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createChannel, deleteChannel, MayflyFatalError, type MayflyMessage, openChannel, type Channel } from "../mayfly-core.ts";
import { findServerBin, type LocalServer, startServer } from "./mayfly-server.ts";

const bin = findServerBin();
if (!bin && process.env.MAYFLY_REQUIRE_SERVER) throw new Error("MAYFLY_REQUIRE_SERVER is set but no Mayfly server binary was found");
const skip = bin ? false : "no Mayfly server binary: set MAYFLY_SERVER_BIN or put `mayfly` on PATH";
if (!bin) console.log(`# integration tests skipped: ${skip}`);

/** Run a watcher and collect its batches. */
function watchInto(ch: Channel, opts?: { since?: number }) {
  const got: MayflyMessage[] = [];
  const waiters: (() => void)[] = [];
  const ac = new AbortController();
  const done = ch.watch(
    (msgs) => {
      got.push(...msgs);
      waiters.splice(0).forEach((w) => w());
    },
    ac.signal,
    opts,
  );
  return {
    got,
    done,
    stop: () => ac.abort(),
    async until(pred: (m: MayflyMessage[]) => boolean, ms = 5000) {
      const end = Date.now() + ms;
      while (!pred(got)) {
        if (Date.now() > end) throw new Error(`timeout; got ${JSON.stringify(got.map((m) => [m.seq, m.from, m.text]))}`);
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 100);
        });
      }
    },
  };
}

describe("core against a local Mayfly server", { skip }, () => {
  let srv: LocalServer;
  const cleanup: (() => void)[] = [];
  before(async () => {
    srv = await startServer(bin!);
  });
  after(async () => {
    cleanup.forEach((f) => f());
    await srv?.stop();
  });
  const newChan = async () => (await createChannel(srv.origin)).url;
  const open = (url: string, name: string) => {
    const ch = openChannel(url, name);
    cleanup.push(() => ch.close());
    return ch;
  };

  test("createChannel (mayfly_new path): empty channel, keyless redacted URL", async () => {
    const c = await createChannel(srv.origin);
    assert.match(c.url, new RegExp(`^${srv.origin}/c/${c.id}#[A-Za-z0-9_-]{43}$`));
    assert.equal(c.redactedUrl, `${srv.origin}/c/${c.id}`);
    assert.ok(!c.redactedUrl.includes("#"));
    const ch = open(c.url, "Maker");
    assert.deepEqual(await ch.history(10), []);
    const r = await ch.post("first");
    assert.equal(r.posted, true);
    assert.equal(r.id, 0);
    await assert.rejects(createChannel(`${srv.origin}/some/path`), /no path/);
    await assert.rejects(createChannel("ftp://example.com"), /http\(s\)/);
  });

  test("post wakes a watcher; own messages are skipped", async () => {
    const url = await newChan();
    const a = open(url, "A");
    const b = open(url, "B");
    const w = watchInto(a);
    await new Promise((r) => setTimeout(r, 200)); // let the watcher prime at the head
    await a.post("from A (own, never delivered to A)");
    const r = await b.post("@A hello");
    assert.equal(r.posted, true);
    await w.until((g) => g.some((m) => m.text === "@A hello"));
    assert.equal(w.got.filter((m) => m.from === "A").length, 0);
    assert.ok(a.ownSeqs.has(0));
    assert.equal(a.last, r.id);
    w.stop();
    await w.done;
  });

  test("dedup: each message reaches the model once, via the watcher or a post result", async () => {
    const url = await newChan();
    const a = open(url, "A");
    const b = open(url, "B");
    const w = watchInto(a);
    await new Promise((r) => setTimeout(r, 200));
    const viaPost: MayflyMessage[] = [];
    const bSeqs: number[] = [];
    for (let i = 0; i < 6; i++) {
      const [rb, ra] = await Promise.all([b.post(`b${i}`), a.post(`a${i}`)]);
      if (rb.posted) bSeqs.push(rb.id!);
      viaPost.push(...ra.newMessages);
      if (ra.conflict) {
        const retry = await a.post(`a${i} retry`);
        viaPost.push(...retry.newMessages);
      }
    }
    await w.until((g) => bSeqs.every((s) => g.some((m) => m.seq === s) || viaPost.some((m) => m.seq === s)));
    await new Promise((r) => setTimeout(r, 300));
    const all = [...w.got, ...viaPost];
    for (const s of bSeqs) assert.equal(all.filter((m) => m.seq === s).length, 1, `seq ${s} delivered exactly once`);
    assert.equal(all.filter((m) => m.from === "A").length, 0);
    w.stop();
    await w.done;
  });

  test("409 conflict: exactly one of two concurrent posts wins; the loser gets the missed message", async () => {
    const url = await newChan();
    const x = open(url, "X");
    const y = open(url, "Y");
    await y.post("y0"); // Y primed at 0
    await x.post("x1"); // X primed at 1
    const stale = await y.post("y-stale"); // Y still thinks head is 0
    assert.equal(stale.posted, false);
    assert.equal(stale.conflict, true);
    assert.deepEqual(stale.newMessages.map((m) => [m.from, m.text]), [["X", "x1"]]);
    // Both cursors now at 1: race.
    const [rx, ry] = await Promise.all([x.post("race X"), y.post("race Y")]);
    assert.equal([rx, ry].filter((r) => r.posted === true).length, 1, "exactly one wins");
    const [win, lose, winText] = rx.posted ? [rx, ry, "race X"] : [ry, rx, "race Y"];
    assert.equal(lose.conflict, true);
    assert.equal(lose.posted, false);
    assert.deepEqual(lose.newMessages.map((m) => [m.seq, m.text]), [[win.id, winText]]);
    const hist = await x.history(10);
    assert.deepEqual(hist.map((m) => m.text), ["y0", "x1", winText]);
  });

  test("409 conflict: conflictEvents lists what raced the post, even if the watcher already delivered it", async () => {
    const url = await newChan();
    const x = open(url, "X");
    const y = open(url, "Y");
    await y.post("y0");
    const w = watchInto(y);
    await new Promise((r) => setTimeout(r, 200));
    // Y's POST is in flight with a stale cursor while x1 lands and Y's watcher delivers it.
    const realFetch = globalThis.fetch;
    let delay = true;
    globalThis.fetch = (async (u: any, init: any) => {
      if (init?.method === "POST" && delay && String(u).includes("last=")) {
        delay = false;
        await w.until((g) => g.some((m) => m.text === "x1"));
      }
      return realFetch(u, init);
    }) as any;
    let r;
    try {
      const pending = y.post("y-stale");
      await x.post("x1");
      r = await pending;
    } finally {
      globalThis.fetch = realFetch;
    }
    w.stop();
    await w.done;
    assert.equal(r.conflict, true);
    assert.deepEqual(r.newMessages, [], "dedup keeps what the watcher delivered out of newMessages");
    assert.deepEqual(r.conflictEvents!.map((m) => [m.from, m.text]), [["X", "x1"]]);
  });

  test("resume via since replays only later messages; a fresh watcher starts at the head", async () => {
    const url = await newChan();
    const p = open(url, "Poster");
    for (let i = 0; i < 5; i++) await p.post(`m${i}`);
    const resumed = watchInto(open(url, "R"), { since: 2 });
    await resumed.until((g) => g.length >= 2);
    assert.deepEqual(resumed.got.map((m) => m.text), ["m3", "m4"]);
    const fresh = watchInto(open(url, "F"));
    await new Promise((r) => setTimeout(r, 300));
    await p.post("m5");
    await fresh.until((g) => g.length >= 1);
    assert.deepEqual(fresh.got.map((m) => m.text), ["m5"]);
    await resumed.until((g) => g.length >= 3);
    resumed.stop();
    fresh.stop();
    await Promise.all([resumed.done, fresh.done]);
  });

  test("history returns the tail (all senders) and learns our own seqs", async () => {
    const url = await newChan();
    const me = open(url, "Me");
    const other = open(url, "Other");
    await me.post("one");
    await other.post("two");
    await other.post("three");
    const again = open(url, "Me"); // e.g. after a restart: no posts this session yet
    assert.equal(again.ownSeqs.size, 0);
    const h = await again.history(2);
    assert.deepEqual(h.map((m) => [m.seq, m.from, m.text]), [[1, "Other", "two"], [2, "Other", "three"]]);
    await again.history(10);
    assert.deepEqual([...again.ownSeqs], [0]);
    assert.equal((await again.history(100)).length, 3);
  });

  test("a deleted channel ends the watcher with MayflyFatalError 404", async () => {
    const url = await newChan();
    const a = open(url, "A");
    const w = watchInto(a);
    await new Promise((r) => setTimeout(r, 200)); // pending long poll
    await deleteChannel(url);
    await assert.rejects(w.done, (e: any) => e instanceof MayflyFatalError && e.status === 404);
    await assert.rejects(a.post("anyone?"), (e: any) => e instanceof MayflyFatalError && e.status === 404);
  });
});
