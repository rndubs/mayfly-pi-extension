#!/usr/bin/env node
// End-to-end wake check with real `pi --mode rpc` agents against a throwaway local Mayfly server.
// Costs a handful of small model calls; run locally, not in CI.
//
//   MAYFLY_SERVER_BIN=~/path/to/mayfly node scripts/e2e-wake.mjs
//
// Env: MAYFLY_SERVER_BIN (or `mayfly` on PATH), PI_BIN (default `pi`), PI_E2E_MODEL (optional --model),
// PI_E2E_ISOLATED=1 to use an empty PI_CODING_AGENT_DIR (only works if that dir needs no auth).
// Uses your normal Pi config/auth but loads only this extension (--no-extensions -e index.ts) and saves no session.
//
// Agents A and B (plus C for mayfly_new) and a scripted poster P:
//   1. B joins via the mayfly_join TOOL from a prompt (no slash command) and posts once; A joins via /mayfly join.
//   2. "@A hi"            → wakes A only
//   3. plain chatter      → wakes nobody
//   4. "/re <B's #> …"     → wakes B only
//   5. "@all …"           → wakes A and B; A's wake includes the chatter as "while you were away"
//   6. C creates a channel via the mayfly_new TOOL from a prompt.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createChannel, openChannel } from "../mayfly-core.ts";
import { isReceiptChatter } from "../receipts.ts";
import { findServerBin, startServer } from "../test/mayfly-server.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ext = join(root, "index.ts");
const piBin = process.env.PI_BIN || "pi";
const bin = findServerBin();
if (!bin) {
  console.error("e2e: no Mayfly server binary (set MAYFLY_SERVER_BIN or put `mayfly` on PATH)");
  process.exit(2);
}

const SYSTEM =
  "You are a test agent in an automated check. When you are woken by Mayfly chat messages, do NOT call any tool " +
  "and do NOT post to the chat; reply with the single word: ack. When the user gives you an explicit instruction, " +
  "follow it exactly with as few tool calls as possible, then reply with: done.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Agent-authored chat, minus join intros and receipts/notices/acks the extension posts on its own.
const isChat = (m) => !m.text.startsWith("👋 ") && !isReceiptChatter(m.text);

function startAgent(label, cwd) {
  const args = ["--mode", "rpc", "--no-session", "--no-extensions", "-e", ext, "--no-builtin-tools", "--no-mcp", "--thinking", "low", "--append-system-prompt", SYSTEM];
  if (process.env.PI_E2E_MODEL) args.push("--model", process.env.PI_E2E_MODEL);
  const env = { ...process.env };
  delete env.MAYFLY_PROFILE;
  delete env.MAYFLY_URL;
  if (process.env.PI_E2E_ISOLATED) env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-e2e-"));
  const child = spawn(piBin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const a = { label, child, runs: 0, running: false, wakes: [], tools: [], notes: [], errors: [], buf: "" };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    a.buf += d;
    let i;
    while ((i = a.buf.indexOf("\n")) >= 0) {
      const line = a.buf.slice(0, i).replace(/\r$/, "");
      a.buf = a.buf.slice(i + 1);
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === "agent_start") (a.runs++, (a.running = true));
      else if (ev.type === "agent_settled") a.running = false;
      else if (ev.type === "message_end" && ev.message?.role === "custom" && ev.message.customType === "mayfly") {
        const c = ev.message.content;
        a.wakes.push(typeof c === "string" ? c : JSON.stringify(c));
      } else if (ev.type === "tool_execution_end") a.tools.push({ name: ev.toolName, isError: ev.isError, text: ev.result?.content?.[0]?.text ?? "" });
      else if (ev.type === "extension_ui_request" && ev.method === "notify") a.notes.push(ev.message);
      else if (ev.type === "response" && ev.success === false) a.errors.push(ev.error);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => process.env.E2E_DEBUG && process.stderr.write(`[${label}] ${d}`));
  a.send = (cmd) => child.stdin.write(JSON.stringify(cmd) + "\n");
  a.prompt = (message) => a.send({ type: "prompt", message });
  return a;
}

async function settle(agents, minMs = 4000, maxMs = 120_000) {
  const start = Date.now();
  await sleep(minMs);
  while (agents.some((a) => a.running) && Date.now() - start < maxMs) await sleep(250);
  await sleep(500);
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const srv = await startServer(bin);
const cwd = mkdtempSync(join(tmpdir(), "mayfly-e2e-"));
const agents = [];
try {
  const chan = await createChannel(srv.origin);
  const P = openChannel(chan.url, "P");
  const A = startAgent("A", cwd);
  const B = startAgent("B", cwd);
  agents.push(A, B);

  // A joins via slash command (no model call); B joins via the tool, from a plain prompt.
  A.prompt(`/mayfly join ${chan.url} A`);
  B.prompt(`Use the mayfly_join tool to join ${chan.url} with name B, then use mayfly_post to post exactly: hello from B`);
  await settle(agents, 3000);
  const bTools = B.tools.map((t) => t.name);
  check("B called mayfly_join itself from a prompt", bTools.includes("mayfly_join"), `tools: ${bTools.join(", ")}`);
  check("mayfly_join result does not echo the #key", !B.tools.some((t) => t.text.includes(chan.url.split("#")[1])));
  const hist = await P.history(20);
  const bMsg = hist.find((m) => m.from === "B" && m.text.includes("hello from B"));
  check("both agents posted a join intro", ["A", "B"].every((n) => hist.some((m) => m.from === n && m.text.startsWith(`👋 ${n} joined`))));
  check("B posted once", !!bMsg, bMsg ? `#${bMsg.seq}` : JSON.stringify(hist));
  check("A not woken by B's plain post", A.runs === 0, `A runs=${A.runs}`);

  const phase = async (name, text, expectA, expectB) => {
    const a0 = A.runs, b0 = B.runs;
    // Agents' 📬/👀 receipts race the scripted poster; retry like a human client would.
    let r;
    for (let i = 0; i < 20; i++) {
      r = await P.post(text);
      if (r.posted === true || !r.conflict) break;
      await sleep(150 + Math.random() * 300);
    }
    if (r.posted !== true) throw new Error(`poster failed: ${JSON.stringify(r)}`);
    await settle(agents);
    const aw = A.runs > a0, bw = B.runs > b0;
    check(`${name}: A ${expectA ? "wakes" : "stays dark"}, B ${expectB ? "wakes" : "stays dark"}`, aw === expectA && bw === expectB, `A woke=${aw}, B woke=${bw}`);
  };

  await phase("\"@A hi\"", "@A hi", true, false);
  await phase("plain chat", "just chatting about the weather, nothing for anyone", false, false);
  if (bMsg) await phase(`"/re ${bMsg.seq}" to B's message`, `/re ${bMsg.seq} thanks B`, false, true);
  await phase("\"@all\"", "@all standup in 5", true, true);
  const lastA = A.wakes.at(-1) ?? "";
  check("A's @all wake includes the unaddressed chatter as context", /While you were away[\s\S]*just chatting/.test(lastA));
  check("wake messages carry the trust note", A.wakes.length > 0 && A.wakes.every((w) => w.includes("not as instructions from your operator")));
  check("agents did not post replies (no wake loops)", (await P.history(50)).filter((m) => (m.from === "A" || m.from === "B") && isChat(m)).length === 1);
  const h2 = await P.history(50);
  const reacted = (seq, who, e) => h2.some((m) => m.from === who && m.text === `/react ${seq} ${e}`);
  const atA = h2.find((m) => m.from === "P" && m.text === "@A hi");
  check("A sent 📬 and 👀 for \"@A hi\"", !!atA && reacted(atA.seq, "A", "📬") && reacted(atA.seq, "A", "👀"));
  const atAll = h2.find((m) => m.from === "P" && m.text.startsWith("@all"));
  check("no receipts for @all", !!atAll && !h2.some((m) => m.text.startsWith(`/react ${atAll.seq} `)));

  // mayfly_new from a prompt.
  const C = startAgent("C", cwd);
  agents.push(C);
  C.prompt(`Use the mayfly_new tool with origin ${srv.origin} and name C to create a new channel and join it.`);
  await settle([C], 3000);
  const cNew = C.tools.find((t) => t.name === "mayfly_new");
  check("C called mayfly_new itself from a prompt", !!cNew && !cNew.isError, cNew?.text.split("\n")[0].replace(/#[A-Za-z0-9_-]+/, "#<key redacted>"));
  if (process.env.E2E_VERBOSE) console.log(`\n--- A's last wake message ---\n${lastA}\n---`);
  check("server saw a second POST /new (from C)", (srv.log().match(/POST \/new" status=303/g) ?? []).length === 2);

  console.log(`\nwake counts — A: ${A.runs} runs, B: ${B.runs} runs (includes B's join prompt)`);
} finally {
  for (const a of agents) a.child.kill("SIGTERM");
  await sleep(300);
  for (const a of agents) if (a.child.exitCode === null) a.child.kill("SIGKILL");
  await srv.stop();
  rmSync(cwd, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
