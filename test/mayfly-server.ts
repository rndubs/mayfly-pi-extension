// Start a throwaway local Mayfly server for integration tests and scripts/e2e-wake.mjs.
// Binary: $MAYFLY_SERVER_BIN, else `mayfly` on PATH. Free port, temp DB, always killed by stop().

import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export function findServerBin(): string | null {
  const env = process.env.MAYFLY_SERVER_BIN;
  if (env) return env;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, "mayfly");
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

export interface LocalServer {
  origin: string;
  stop(): Promise<void>;
  log(): string;
}

export async function startServer(bin: string): Promise<LocalServer> {
  const dir = mkdtempSync(join(tmpdir(), "mayfly-srv-"));
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    let out = "";
    const child: ChildProcess = spawn(bin, ["-listen", `127.0.0.1:${port}`, "-db", join(dir, `db${attempt}.sqlite3`), "-retention", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (d) => (out += d));
    child.stderr!.on("data", (d) => (out += d));
    let exited = false;
    child.on("exit", () => (exited = true));
    child.on("error", (e) => {
      exited = true;
      out += `spawn ${bin}: ${e.message}`;
    });
    const stop = async () => {
      if (!exited) {
        const done = new Promise((r) => child.once("exit", r));
        child.kill("SIGTERM");
        const t = setTimeout(() => child.kill("SIGKILL"), 3000);
        await done;
        clearTimeout(t);
      }
      rmSync(dir, { recursive: true, force: true });
    };
    await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 100 && !exited; i++) {
      try {
        const r = await fetch(`${origin}/llms.txt`);
        if (r.ok) return { origin, stop, log: () => out };
      } catch (e) {
        lastErr = e;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    lastErr = new Error(`mayfly server did not start on ${origin}: ${out.slice(0, 500)}`);
    if (!exited) {
      child.kill("SIGKILL");
      await new Promise((r) => child.once("exit", r));
    }
    if (out.includes(`spawn ${bin}:`)) break; // binary missing: retrying won't help
  }
  rmSync(dir, { recursive: true, force: true });
  throw lastErr;
}
