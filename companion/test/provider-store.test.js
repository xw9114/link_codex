const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { MemoryCredentialManager } = require("../src/core/credential-manager");
const { ProviderStore, responsesEndpoint } = require("../src/core/provider-store");

function fixture(t, fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ id: "resp" }) })) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codexlink-provider-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const credentialManager = new MemoryCredentialManager();
  const store = new ProviderStore({
    filePath: path.join(root, "providers.json"),
    profilePath: path.join(root, "codexlink.config.toml"),
    credentialManager,
    fetchImpl,
  });
  return { root, store, credentialManager };
}

test("provider metadata and generated config never contain secret values", async (t) => {
  const { root, store } = fixture(t);
  await store.initialize();
  const profile = await store.upsert({
    kind: "custom_responses",
    displayName: "Lab",
    baseUrl: "https://llm.example/v1/",
    defaultModel: "model-a",
    apiKey: "sk-super-secret-value",
    headers: { "X-Tenant": "tenant-secret" },
  });
  assert.equal(profile.hasCredential, true);
  assert.equal(JSON.stringify(store.list()).includes("super-secret"), false);
  const metadata = fs.readFileSync(path.join(root, "providers.json"), "utf8");
  const config = fs.readFileSync(path.join(root, "codexlink.config.toml"), "utf8");
  assert.equal(metadata.includes("sk-super-secret-value"), false);
  assert.equal(metadata.includes("tenant-secret"), false);
  assert.equal(config.includes("sk-super-secret-value"), false);
  assert.match(config, /wire_api = "responses"/);
  assert.match(config, /env_key = "CODEXLINK_PROVIDER_/);
  const env = await store.buildEnvironment({ SAFE: "1" });
  assert.equal(Object.values(env).includes("sk-super-secret-value"), true);
  assert.equal(Object.values(env).includes("tenant-secret"), true);
  const overrides = store.buildCodexConfigOverrides();
  assert.equal(overrides.some((value) => value.includes("model_providers.codexlink_")), true);
  assert.equal(overrides.some((value) => value.includes("sk-super-secret-value")), false);
  assert.equal(overrides.some((value) => value.includes("tenant-secret")), false);
});

test("connection test maps auth errors without returning upstream bodies", async (t) => {
  const { store } = fixture(t, async () => ({ ok: false, status: 401 }));
  await store.initialize();
  const profile = await store.upsert({
    kind: "openai_responses",
    displayName: "OpenAI",
    defaultModel: "gpt-test",
    apiKey: "not-logged",
  });
  const result = await store.test(profile.id);
  assert.deepEqual({ ok: result.ok, category: result.category }, { ok: false, category: "auth_failed" });
  assert.equal(responsesEndpoint("https://api.openai.com/v1"), "https://api.openai.com/v1/responses");
});

test("provider metadata can be edited without resubmitting or exposing its credential", async (t) => {
  const { store } = fixture(t);
  await store.initialize();
  const created = await store.upsert({
    kind: "custom_responses",
    displayName: "Before",
    baseUrl: "https://llm.example/v1",
    defaultModel: "model-a",
    apiKey: "sk-kept-on-windows",
    headers: { "X-Tenant": "tenant-a" },
  });
  const edited = await store.upsert({
    id: created.id,
    kind: "custom_responses",
    displayName: "After",
    baseUrl: "https://llm.example/v1",
    defaultModel: "model-b",
  });
  assert.equal(edited.displayName, "After");
  const env = await store.buildEnvironment({});
  assert.equal(Object.values(env).includes("sk-kept-on-windows"), true);
  assert.equal(Object.values(env).includes("tenant-a"), true);
  assert.equal(JSON.stringify(edited).includes("sk-kept-on-windows"), false);
});
