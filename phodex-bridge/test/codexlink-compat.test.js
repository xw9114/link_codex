const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildMacRegistrationHeaders,
  resolveConfiguredRelaySessionId,
} = require("../src/bridge");

test("CodexLink accepts only URL-safe persistent relay session ids", () => {
  const id = "8c8e9d60-23b8-4eb6-b034-91143308475d";
  assert.equal(resolveConfiguredRelaySessionId(id), id);
  assert.equal(resolveConfiguredRelaySessionId("short"), "");
  assert.equal(resolveConfiguredRelaySessionId("../not-a-session-id"), "");
});

test("Mac registration headers preserve a non-ASCII hostname without invalid HTTP bytes", () => {
  const originalHostname = require("os").hostname;
  require("os").hostname = () => "开发机-一号";
  try {
    const headers = buildMacRegistrationHeaders({
      macDeviceId: "mac-1",
      macIdentityPublicKey: "public-key",
      trustedPhones: {},
    }, {
      pairingCode: "ABCDEFGH",
      pairingPayload: { v: 2, expiresAt: Date.now() + 60_000 },
    });
    assert.match(headers["x-machine-name"], /^[\x20-\x7e]+$/);
    assert.equal(
      Buffer.from(headers["x-machine-name-b64"], "base64url").toString("utf8"),
      "开发机-一号"
    );
  } finally {
    require("os").hostname = originalHostname;
  }
});
