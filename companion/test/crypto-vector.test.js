const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  buildTranscriptBytes,
  deriveAesKey,
  nonceForDirection,
} = require("../../phodex-bridge/src/secure-transport");

test("shared Remodex v2 vector matches Node transcript, nonce, and HKDF", () => {
  const vector = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "protocol", "test-vectors", "secure-v2.json"), "utf8"));
  const fields = {
    ...vector.fields,
    clientNonce: Buffer.from(vector.fields.clientNonce, "base64"),
    serverNonce: Buffer.from(vector.fields.serverNonce, "base64"),
  };
  const transcript = buildTranscriptBytes(fields);
  assert.equal(transcript.toString("base64"), vector.transcript);
  assert.equal(nonceForDirection("mac", 5).toString("base64"), vector.nonces.mac5);
  assert.equal(nonceForDirection("iphone", 5).toString("base64"), vector.nonces.iphone5);
  const info = `remodex-e2ee-v1|${fields.sessionId}|${fields.macDeviceId}|${fields.phoneDeviceId}|${fields.keyEpoch}|phoneToMac`;
  assert.equal(deriveAesKey(Buffer.from(vector.sharedSecret, "base64"), Buffer.from(vector.salt, "base64"), info).toString("base64"), vector.phoneToMacKey);
});
