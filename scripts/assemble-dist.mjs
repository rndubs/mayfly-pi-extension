// Build the install-ready tree that the release workflow pushes to the `dist` branch.
// Usage: node scripts/assemble-dist.mjs <outDir>   (run after `npm run build`)
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2];
if (!out) throw new Error("usage: assemble-dist.mjs <outDir>");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const f of readdirSync("dist")) cpSync(join("dist", f), join(out, f), { recursive: true });
for (const f of ["README.md", "CHANGELOG.md", "THIRD_PARTY_NOTICES.md"]) cpSync(f, join(out, f));

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const release = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  private: true,
  license: pkg.license,
  type: "module",
  main: "./index.js",
  types: "./index.d.ts",
  pi: { extensions: ["./index.js"] },
  // Host-provided by Pi; never installed (Pi runs `npm install --omit=dev --legacy-peer-deps`).
  peerDependencies: pkg.peerDependencies,
};
writeFileSync(join(out, "package.json"), JSON.stringify(release, null, 2) + "\n");
console.log(`assembled ${pkg.name}@${pkg.version} in ${out}`);
