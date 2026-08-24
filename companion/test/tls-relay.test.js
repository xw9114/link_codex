const assert = require("node:assert/strict");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadOrCreateTlsIdentity } = require("../src/core/tls-identity");
const { createRelayServer } = require("../../relay/server");

test("relay can serve health over TLS with a persistent pinned identity", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codexlink-tls-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = await loadOrCreateTlsIdentity({ directory: root, ipAddress: "127.0.0.1" });
  const second = await loadOrCreateTlsIdentity({ directory: root, ipAddress: "127.0.0.1" });
  assert.equal(first.spkiSha256, second.spkiSha256);
  assert.equal(Buffer.from(first.spkiSha256, "base64").length, 32);
  const { server } = createRelayServer({ tlsOptions: { cert: first.cert, key: first.key } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const body = await new Promise((resolve, reject) => {
    https.get({ hostname: "127.0.0.1", port, path: "/health", rejectUnauthorized: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    }).on("error", reject);
  });
  assert.deepEqual(JSON.parse(body), { ok: true });
});
