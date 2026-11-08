import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLED_PROFILES_DIR, DEFAULT_PROFILE, loadProfileFile, mergeProfile, resolveProfilePath, validateProfile } from "../profile.ts";

test("defaults", () => {
  const p = mergeProfile();
  assert.equal(p.wake, "addressed");
  assert.deepEqual(p.groups, []);
  assert.deepEqual(p.context, { recentK: 10, maxBytes: 16384 });
  assert.deepEqual(p.budget, { burst: 6, refillPerMinute: 1, hourlyCap: 30, quietResumeMinutes: 10 });
  assert.equal(p.allowStop, "anyone");
  assert.equal(p.requireAtForMention, true);
  assert.equal(p.name, undefined);
});

test("merge order: defaults <- file <- overrides; nested keys merge", () => {
  const file = validateProfile({ name: "Rev", groups: ["reviewers"], wake: "all", budget: { burst: 2 }, context: { recentK: 3 } });
  const flags = validateProfile({ wake: "none", budget: { hourlyCap: 7 } });
  const p = mergeProfile(file, flags);
  assert.equal(p.name, "Rev");
  assert.deepEqual(p.groups, ["reviewers"]);
  assert.equal(p.wake, "none");
  assert.deepEqual(p.budget, { burst: 2, refillPerMinute: 1, hourlyCap: 7, quietResumeMinutes: 10 });
  assert.deepEqual(p.context, { recentK: 3, maxBytes: 16384 });
  // Merging never mutates the defaults.
  assert.deepEqual(DEFAULT_PROFILE.groups, []);
  assert.equal(DEFAULT_PROFILE.budget.burst, 6);
});

test("validation reports every problem clearly", () => {
  assert.throws(() => validateProfile([]), /expected a JSON object/);
  try {
    validateProfile({ wake: "sometimes", groups: ["ok", "bad tag"], budget: { burst: 0, nope: 1 }, context: { maxBytes: 10 }, allowStop: 3, extra: true, requireAtForMention: "yes" }, "p.json");
    assert.fail("should throw");
  } catch (e: any) {
    const m = e.message as string;
    assert.match(m, /^p\.json: /);
    for (const want of [/unknown key "extra"/, /wake: must be one of addressed, all, none/, /groups:/, /budget\.burst: must be an integer >= 1/, /budget\.nope: unknown key/, /context\.maxBytes: must be an integer >= 1024/, /allowStop:/, /requireAtForMention:/])
      assert.match(m, want);
  }
  assert.deepEqual(validateProfile({ groups: ["@reviewers", "reviewers", "ops"] }).groups, ["reviewers", "ops"]);
  assert.deepEqual(validateProfile({ allowStop: ["human ", "Claude"] }).allowStop, ["human", "Claude"]);
  assert.deepEqual(validateProfile({ description: "comment", $schema: "x" }), {});
});

test("bundled profiles are valid", () => {
  const files = readdirSync(BUNDLED_PROFILES_DIR).filter((f) => f.endsWith(".json"));
  assert.ok(files.includes("default.json") && files.includes("subscribed.json"));
  for (const f of files) loadProfileFile(join(BUNDLED_PROFILES_DIR, f), "/");
  // default.json matches the built-in defaults exactly.
  assert.deepEqual(mergeProfile(loadProfileFile("default", "/").profile), mergeProfile());
  assert.equal(mergeProfile(loadProfileFile("subscribed", "/").profile).wake, "all");
});

test("profile paths: bundled name, relative path, errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "mayfly-prof-"));
  writeFileSync(join(dir, "mine.json"), JSON.stringify({ wake: "none" }));
  writeFileSync(join(dir, "broken.json"), "{ nope");
  writeFileSync(join(dir, "invalid.json"), JSON.stringify({ wake: 1 }));
  assert.equal(resolveProfilePath("subscribed", dir), join(BUNDLED_PROFILES_DIR, "subscribed.json"));
  assert.equal(loadProfileFile("mine.json", dir).profile.wake, "none");
  assert.equal(loadProfileFile(join(dir, "mine.json"), "/").path, join(dir, "mine.json"));
  assert.throws(() => loadProfileFile("missing.json", dir), /cannot read .*missing\.json \(ENOENT\)/);
  assert.throws(() => loadProfileFile("broken.json", dir), /invalid JSON/);
  assert.throws(() => loadProfileFile("invalid.json", dir), /invalid\.json: wake: must be one of/);
});
