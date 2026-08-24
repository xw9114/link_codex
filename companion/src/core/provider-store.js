const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { AtomicJsonStore } = require("./atomic-json-store");

const PROVIDER_KINDS = new Set(["chatgpt", "openai_responses", "custom_responses"]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function normalizeBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw Object.assign(new Error("Provider Base URL must be a valid HTTP(S) URL."), { code: "invalid_base_url" });
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password) {
    throw Object.assign(new Error("Provider Base URL must be an HTTP(S) URL without embedded credentials."), {
      code: "invalid_base_url",
    });
  }
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/$/, "");
}

function normalizeHeaders(headers = {}) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    throw Object.assign(new Error("Provider headers must be a string map."), { code: "invalid_headers" });
  }
  const normalized = {};
  for (const [name, rawValue] of Object.entries(headers)) {
    const value = String(rawValue || "");
    if (!HEADER_NAME.test(name) || !value || value.length > 8_192) {
      throw Object.assign(new Error(`Invalid provider header: ${name}`), { code: "invalid_headers" });
    }
    if (name.toLowerCase() === "authorization") {
      throw Object.assign(new Error("Use the API Key field instead of an Authorization header."), {
        code: "authorization_header_not_allowed",
      });
    }
    normalized[name] = value;
  }
  return normalized;
}

function responsesEndpoint(baseUrl) {
  const parsed = new URL(normalizeBaseUrl(baseUrl));
  if (!parsed.pathname.endsWith("/responses")) {
    parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/responses`;
  }
  return parsed.toString();
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function providerEnvKey(id) {
  return `CODEXLINK_PROVIDER_${id.replace(/^codexlink_/, "").replace(/-/g, "_").toUpperCase()}_API_KEY`;
}

function headerEnvKey(id, index) {
  return `${providerEnvKey(id).replace(/_API_KEY$/, "")}_HEADER_${index}`;
}

function publicProfile(profile) {
  return {
    id: profile.id,
    kind: profile.kind,
    displayName: profile.displayName,
    baseUrl: profile.baseUrl || null,
    defaultModel: profile.defaultModel || null,
    status: profile.status || "untested",
    lastTestAt: profile.lastTestAt || null,
    hasCredential: profile.kind === "chatgpt" ? true : profile.hasCredential === true,
  };
}

class ProviderStore {
  constructor({ filePath, profilePath, credentialManager, fetchImpl = global.fetch, onChanged = null }) {
    this.store = new AtomicJsonStore(filePath, { providers: [] });
    this.profilePath = profilePath;
    this.credentialManager = credentialManager;
    this.fetchImpl = fetchImpl;
    this.onChanged = onChanged;
  }

  async initialize() {
    const state = this.store.read();
    if (!state.providers.some((provider) => provider.id === "chatgpt")) {
      state.providers.unshift({
        id: "chatgpt",
        kind: "chatgpt",
        displayName: "ChatGPT 登录",
        baseUrl: null,
        defaultModel: null,
        status: "available",
        lastTestAt: null,
        hasCredential: true,
        headerNames: [],
      });
      this.store.write(state);
    }
    await this.writeCodexProfile();
  }

  list() {
    return this.store.read().providers.map(publicProfile);
  }

  getInternal(id) {
    const provider = this.store.read().providers.find((entry) => entry.id === id);
    if (!provider) {
      throw Object.assign(new Error("Provider does not exist."), { code: "provider_not_found" });
    }
    return provider;
  }

  resolveForThread(id) {
    const provider = this.getInternal(id || "chatgpt");
    return {
      providerId: provider.id,
      modelProvider: provider.kind === "chatgpt" ? null : provider.id,
      defaultModel: provider.defaultModel || null,
    };
  }

  async upsert(input) {
    const kind = String(input.kind || "");
    if (!PROVIDER_KINDS.has(kind) || kind === "chatgpt") {
      throw Object.assign(new Error("Only Responses API providers can be created or changed."), {
        code: "invalid_provider_kind",
      });
    }
    const displayName = String(input.displayName || "").trim();
    const defaultModel = String(input.defaultModel || "").trim();
    if (!displayName || !defaultModel) {
      throw Object.assign(new Error("Provider name and default model are required."), {
        code: "invalid_provider",
      });
    }
    const baseUrl = kind === "openai_responses"
      ? normalizeBaseUrl(input.baseUrl || "https://api.openai.com/v1")
      : normalizeBaseUrl(input.baseUrl);
    const headers = normalizeHeaders(input.headers || {});
    const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    const state = this.store.read();
    const existingIndex = state.providers.findIndex((provider) => provider.id === input.id);
    const existing = existingIndex >= 0 ? state.providers[existingIndex] : null;
    const id = existing?.id || `codexlink_${crypto.randomUUID()}`;
    if (existing?.kind === "chatgpt") {
      throw Object.assign(new Error("The ChatGPT provider cannot be modified."), { code: "provider_read_only" });
    }

    const existingCredential = existing?.hasCredential ? await this.#readCredential(id) : null;
    const hasNewHeaders = Object.keys(headers).length > 0;
    const credential = {
      apiKey: apiKey || existingCredential?.apiKey || "",
      headers: hasNewHeaders ? headers : (existingCredential?.headers || {}),
    };
    if (!credential?.apiKey) {
      throw Object.assign(new Error("An API Key is required for a Responses provider."), {
        code: "credential_required",
      });
    }
    if (apiKey || hasNewHeaders || !existingCredential) {
      await this.credentialManager.set(this.#credentialTarget(id), JSON.stringify(credential));
    }

    const next = {
      id,
      kind,
      displayName,
      baseUrl,
      defaultModel,
      status: existing?.status || "untested",
      lastTestAt: existing?.lastTestAt || null,
      hasCredential: true,
      headerNames: Object.keys(credential.headers || {}),
      updatedAt: new Date().toISOString(),
    };
    if (existingIndex >= 0) state.providers[existingIndex] = next;
    else state.providers.push(next);
    this.store.write(state);
    await this.writeCodexProfile();
    await this.onChanged?.({ reason: existing ? "provider_updated" : "provider_added", providerId: id });
    return publicProfile(next);
  }

  async delete(id) {
    if (id === "chatgpt") {
      throw Object.assign(new Error("The ChatGPT provider cannot be deleted."), { code: "provider_read_only" });
    }
    const state = this.store.read();
    const nextProviders = state.providers.filter((provider) => provider.id !== id);
    if (nextProviders.length === state.providers.length) return false;
    await this.credentialManager.delete(this.#credentialTarget(id));
    this.store.write({ ...state, providers: nextProviders });
    await this.writeCodexProfile();
    await this.onChanged?.({ reason: "provider_deleted", providerId: id });
    return true;
  }

  async buildEnvironment(baseEnv = process.env) {
    const env = { ...baseEnv };
    for (const provider of this.store.read().providers) {
      if (provider.kind === "chatgpt") continue;
      const credential = await this.#readCredential(provider.id);
      if (!credential?.apiKey) continue;
      env[providerEnvKey(provider.id)] = credential.apiKey;
      Object.values(credential.headers || {}).forEach((value, index) => {
        env[headerEnvKey(provider.id, index)] = value;
      });
    }
    return env;
  }

  buildCodexConfigOverrides() {
    const overrides = [];
    for (const provider of this.store.read().providers) {
      if (provider.kind === "chatgpt") continue;
      const prefix = `model_providers.${provider.id}`;
      overrides.push(`${prefix}.name=${tomlString(provider.displayName)}`);
      overrides.push(`${prefix}.base_url=${tomlString(provider.baseUrl)}`);
      overrides.push(`${prefix}.env_key=${tomlString(providerEnvKey(provider.id))}`);
      overrides.push(`${prefix}.wire_api="responses"`);
      overrides.push(`${prefix}.requires_openai_auth=false`);
      if (provider.headerNames?.length) {
        const mappings = provider.headerNames.map((name, index) => (
          `${tomlString(name)} = ${tomlString(headerEnvKey(provider.id, index))}`
        ));
        overrides.push(`${prefix}.env_http_headers={ ${mappings.join(", ")} }`);
      }
    }
    return overrides;
  }

  async test(id, { timeoutMs = 15_000 } = {}) {
    const provider = this.getInternal(id);
    if (provider.kind === "chatgpt") {
      return { ok: true, category: "chatgpt_login", message: "ChatGPT 登录状态由 Codex 管理。" };
    }
    const credential = await this.#readCredential(id);
    if (!credential?.apiKey) {
      return this.#rememberTest(id, { ok: false, category: "auth_failed", message: "缺少 API Key。" });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let result;
    try {
      const response = await this.fetchImpl(responsesEndpoint(provider.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credential.apiKey}`,
          ...(credential.headers || {}),
        },
        body: JSON.stringify({
          model: provider.defaultModel,
          input: "Reply exactly OK",
          max_output_tokens: 8,
          stream: false,
        }),
        signal: controller.signal,
      });
      if (response.ok) {
        const body = await response.json().catch(() => null);
        result = body && typeof body === "object"
          ? { ok: true, category: "success", message: "Responses API 连接成功。" }
          : { ok: false, category: "protocol_incompatible", message: "服务返回的不是 Responses JSON。" };
      } else if (response.status === 401 || response.status === 403) {
        result = { ok: false, category: "auth_failed", message: "API Key 鉴权失败。" };
      } else if (response.status === 404) {
        result = { ok: false, category: "model_or_endpoint_not_found", message: "Responses 端点或模型不存在。" };
      } else if (response.status === 400) {
        result = { ok: false, category: "protocol_incompatible", message: "服务不兼容 Responses API 请求。" };
      } else {
        result = { ok: false, category: "upstream_error", message: `服务返回 HTTP ${response.status}。` };
      }
    } catch (error) {
      result = {
        ok: false,
        category: error.name === "AbortError" ? "timeout" : "network_error",
        message: error.name === "AbortError" ? "连接测试超时。" : "无法连接 Responses API。",
      };
    } finally {
      clearTimeout(timer);
    }
    return this.#rememberTest(id, result);
  }

  async writeCodexProfile() {
    const lines = [
      "# Generated by CodexLink Companion. API keys and header values are injected via environment variables.",
      "",
    ];
    for (const provider of this.store.read().providers) {
      if (provider.kind === "chatgpt") continue;
      lines.push(`[model_providers.${provider.id}]`);
      lines.push(`name = ${tomlString(provider.displayName)}`);
      lines.push(`base_url = ${tomlString(provider.baseUrl)}`);
      lines.push(`env_key = ${tomlString(providerEnvKey(provider.id))}`);
      lines.push('wire_api = "responses"');
      lines.push("requires_openai_auth = false");
      if (provider.headerNames?.length) {
        const mappings = provider.headerNames.map((name, index) => (
          `${tomlString(name)} = ${tomlString(headerEnvKey(provider.id, index))}`
        ));
        lines.push(`env_http_headers = { ${mappings.join(", ")} }`);
      }
      lines.push("");
    }
    fs.mkdirSync(path.dirname(this.profilePath), { recursive: true });
    const temporary = `${this.profilePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.profilePath);
  }

  async #readCredential(id) {
    const raw = await this.credentialManager.get(this.#credentialTarget(id));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return { apiKey: String(parsed.apiKey || ""), headers: normalizeHeaders(parsed.headers || {}) };
    } catch {
      throw Object.assign(new Error("The saved provider credential is invalid."), {
        code: "credential_corrupt",
      });
    }
  }

  #credentialTarget(id) {
    return `CodexLink/Provider/${id}`;
  }

  #rememberTest(id, result) {
    const state = this.store.read();
    const provider = state.providers.find((entry) => entry.id === id);
    if (provider) {
      provider.status = result.ok ? "online" : result.category;
      provider.lastTestAt = new Date().toISOString();
      this.store.write(state);
    }
    return { ...result, testedAt: provider?.lastTestAt || new Date().toISOString() };
  }
}

module.exports = {
  PROVIDER_KINDS,
  ProviderStore,
  headerEnvKey,
  normalizeBaseUrl,
  normalizeHeaders,
  providerEnvKey,
  publicProfile,
  responsesEndpoint,
};
