import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deriveKeys, sealMessage, openEvent, parseStop, openChannel, validName } from "../mayfly-core.ts";

// Official vectors from github.com/josharian/mayfly srv/static/vectors.json.
const vectors = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));
const unb64 = (s: string) => Buffer.from(s, "base64url");

test("key derivation matches Mayfly vectors", () => {
  for (const v of vectors) {
    const k = deriveKeys(unb64(v.K));
    assert.equal(k.id, v.id);
    assert.equal(k.auth, v.auth);
    assert.equal(k.enc.toString("base64url"), v.enc);
  }
});

// One vector is an empty plaintext (padding edge case); it isn't a {from,text} message.
const messageVectors = vectors.filter((v: any) => v.plaintext !== "");

test("sealing matches Mayfly vectors byte-for-byte", () => {
  for (const v of messageVectors) {
    const k = deriveKeys(unb64(v.K));
    const sealed = sealMessage(k, v.seq, JSON.parse(v.plaintext), unb64(v.nonce));
    assert.equal(sealed.ct, v.ct);
    assert.equal(unb64(sealed.ct).length - 16, v.padded_len);
  }
});

test("opening vectors recovers the plaintext", () => {
  for (const v of messageVectors) {
    const k = deriveKeys(unb64(v.K));
    const msg = openEvent(k, { seq: v.seq, ts: "t", src: "s", nonce: v.nonce, ct: v.ct });
    const inner = JSON.parse(v.plaintext);
    assert.equal(msg.from, inner.from);
    assert.equal(msg.text, inner.text);
  }
});

test("empty-plaintext vector decrypts but is reported as an invalid message", () => {
  const v = vectors.find((x: any) => x.plaintext === "");
  assert.ok(v, "vectors.json should include the empty-plaintext case");
  const msg = openEvent(deriveKeys(unb64(v.K)), { seq: v.seq, nonce: v.nonce, ct: v.ct });
  assert.equal(msg.from, "");
  assert.equal(msg.text, "(invalid message)");
});

test("wrong seq (AAD) or tampering yields a placeholder, not an exception", () => {
  const v = vectors[0];
  const k = deriveKeys(unb64(v.K));
  assert.equal(openEvent(k, { seq: v.seq + 1, nonce: v.nonce, ct: v.ct }).text, "(undecryptable message)");
  const bad = unb64(v.ct); bad[0] ^= 1;
  assert.equal(openEvent(k, { seq: v.seq, nonce: v.nonce, ct: bad.toString("base64url") }).from, "");
  assert.equal(openEvent(k, { seq: 0, nonce: "!!", ct: "x" }).text, "(undecryptable message)");
});

test("parseStop", () => {
  assert.deepEqual(parseStop("/stop PiLive"), { target: "PiLive", reason: undefined });
  assert.deepEqual(parseStop("/stop @PiLive  runaway loop \n"), { target: "PiLive", reason: "runaway loop" });
  assert.deepEqual(parseStop("/STOP all"), { target: "all", reason: undefined });
  assert.equal(parseStop("please /stop PiLive"), null);
  assert.equal(parseStop("/stop"), null);
  assert.equal(parseStop("/stopper PiLive"), null);
});

test("openChannel URL parsing", () => {
  const v = vectors[0];
  const url = `https://mayfly.chat/c/${v.id}#${v.K}`;
  for (const u of [url, `'${url}'`, `"${url}"`, `<${url}>`, `  ${url}  `]) {
    assert.equal(openChannel(u, "T").redactedUrl, `https://mayfly.chat/c/${v.id}`);
  }
  assert.throws(() => openChannel(`https://mayfly.chat/c/WRONGID#${v.K}`, "T"), /does not match/);
  assert.throws(() => openChannel(`https://mayfly.chat/c/${v.id}`, "T"), /full Mayfly URL/);
  assert.throws(() => openChannel(url, " padded"), /name/);
  assert.equal(validName("Claude"), true);
  assert.equal(validName("a\nb"), false);
});
