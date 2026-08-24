const { EventEmitter } = require("events");
const { execFile } = require("child_process");
const { randomUUID } = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { promisify } = require("util");
const QRCode = require("qrcode");
const { AtomicJsonStore } = require("../core/atomic-json-store");
const { createCompanionPolicy } = require("../core/companion-policy");
const { WindowsCredentialManager } = require("../core/credential-manager");
const { startPrivateRelay } = require("../core/private-relay");
const { ProjectStore } = require("../core/project-store");
const { ProviderStore } = require("../core/provider-store");
const { readTailscaleStatus } = require("../core/tailscale");

const execFileAsync = promisify(execFile);
const MINIMUM_CODEX_VERSION = "0.148.0";

function parseVersion(value) {
  const match = String(value || "").match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

async function readCodexInstallation({ execFileImpl = execFileAsync } = {}) {
  const executable = await resolveCodexExecutable({ execFileImpl });
  const { stdout } = await execCodex(["--version"], { execFileImpl, codexPath: executable });
  const version = parseVersion(stdout)?.join(".") || "";
  if (!version || compareVersions(version, MINIMUM_CODEX_VERSION) < 0) {
    throw Object.assign(new Error(`需要 Codex CLI ${MINIMUM_CODEX_VERSION} 或更高版本。`), {
      code: "codex_version_unsupported",
    });
  }
  return { version, executable };
}

async function readCodexLoginStatus({ execFileImpl = execFileAsync, codexPath = "" } = {}) {
  try {
    const executable = codexPath || await resolveCodexExecutable({ execFileImpl });
    const { stdout, stderr } = await execCodex(["login", "status"], {
      execFileImpl,
      codexPath: executable,
      timeout: 10_000,
    });
    const output = `${stdout}\n${stderr}`.toLowerCase();
    return {
      loggedIn: !output.includes("not logged in") && !output.includes("unauthenticated"),
      label: output.includes("chatgpt") ? "ChatGPT" : "Codex",
    };
  } catch {
    return { loggedIn: false, label: "未登录" };
  }
}

function execCodex(args, {
  execFileImpl = execFileAsync,
  platform = process.platform,
  timeout,
  codexPath = "",
} = {}) {
  const options = { windowsHide: true, ...(timeout ? { timeout } : {}) };
  if (codexPath) {
    return execFileImpl(codexPath, args, options);
  }
  if (platform === "win32") {
    const command = ["codex", ...args].map((value) => {
      const normalized = String(value);
      if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
        throw new Error("Unsupported Codex command argument.");
      }
      return normalized;
    }).join(" ");
    return execFileImpl(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], options);
  }
  return execFileImpl("codex", args, options);
}

async function resolveCodexExecutable({
  execFileImpl = execFileAsync,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  fsImpl = fs,
  pathImpl = path,
} = {}) {
  if (process.env.CODEXLINK_CODEX_PATH && fsImpl.existsSync(process.env.CODEXLINK_CODEX_PATH)) {
    return process.env.CODEXLINK_CODEX_PATH;
  }
  if (platform !== "win32") return "codex";

  const target = arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const packageName = arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64";
  const shims = await whereExecutables("codex.cmd", execFileImpl);
  // A GUI-launched Electron process may not inherit the interactive shell's
  // PATH, so `where codex.cmd` can return nothing even though Codex was
  // installed globally for this user. Include the standard npm global roots
  // as deterministic fallbacks before accepting a WindowsApps shim, which
  // cannot be spawned by a packaged desktop process on some Windows builds.
  const npmRoots = [
    ...shims.map((shim) => pathImpl.dirname(shim)),
    env.APPDATA ? pathImpl.join(env.APPDATA, "npm") : "",
    env.LOCALAPPDATA ? pathImpl.join(env.LOCALAPPDATA, "npm") : "",
  ].filter(Boolean).filter((value, index, values) => values.indexOf(value) === index);
  for (const npmRoot of npmRoots) {
    for (const candidate of [
      pathImpl.join(npmRoot, "node_modules", "@openai", "codex", "node_modules", "@openai", packageName, "vendor", target, "bin", "codex.exe"),
      pathImpl.join(npmRoot, "node_modules", "@openai", "codex", "vendor", target, "bin", "codex.exe"),
    ]) {
      if (fsImpl.existsSync(candidate)) return candidate;
    }
  }
  const nativeCandidates = await whereExecutables("codex.exe", execFileImpl);
  if (nativeCandidates[0] && fsImpl.existsSync(nativeCandidates[0])) return nativeCandidates[0];
  throw Object.assign(new Error("未找到可直接启动的 Codex CLI 可执行文件。请重新安装 Codex CLI。"), {
    code: "codex_not_found",
  });
}

async function whereExecutables(name, execFileImpl) {
  try {
    const { stdout } = await execFileImpl("where.exe", [name], { windowsHide: true });
    return String(stdout || "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

class CompanionService extends EventEmitter {
  constructor({ userDataPath, appRoot }) {
    super();
    this.userDataPath = userDataPath;
    this.appRoot = appRoot;
    this.relay = null;
    this.bridge = null;
    // Invalidates asynchronous callbacks from a bridge instance that is being
    // restarted. Without this fence, an old QR callback can overwrite the new
    // session after a trust reset, leaving the phone with a sessionId for
    // which the relay has no live Mac connection ("Mac session not available").
    this.bridgeGeneration = 0;
    this.policy = null;
    this.pairing = null;
    this.bridgeStatus = { state: "stopped", connectionStatus: "disconnected" };
    this.tailnet = null;
    this.codex = null;
    this.login = null;
    this.providerRestartPending = false;
    this.networkRefreshPromise = null;
    this.monitorTimer = null;
    this.restartTimer = null;
    this.logs = [];
    this.projectStore = new ProjectStore(path.join(userDataPath, "projects.json"));
    this.settingsStore = new AtomicJsonStore(path.join(userDataPath, "desktop-settings.json"), {
      allowDangerFullAccess: false,
      allowNeverApproval: false,
      relaySessionId: null,
    });
    this.credentialManager = new WindowsCredentialManager();
    this.providerStore = new ProviderStore({
      filePath: path.join(userDataPath, "providers.json"),
      profilePath: path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "codexlink.config.toml"),
      credentialManager: this.credentialManager,
      onChanged: () => this.markProviderRestartPending(),
    });
  }

  async start() {
    this.log("info", "正在检查 Codex 与 Tailscale");
    process.env.REMODEX_DEVICE_STATE_DIR = path.join(this.userDataPath, "pairing");
    this.ensureRelaySessionId();
    this.codex = await readCodexInstallation();
    this.login = await readCodexLoginStatus({ codexPath: this.codex.executable });
    await this.providerStore.initialize();
    await this.startNetworkStack();
    this.monitorTimer = setInterval(() => void this.refreshNetwork(), 30_000);
    this.monitorTimer.unref?.();
    this.emitState();
  }

  async startNetworkStack() {
    this.tailnet = await readTailscaleStatus();
    const relayModulePath = this.resolveModulePath("relay", "server.js");
    this.relay = await startPrivateRelay({
      bindHost: this.tailnet.preferredAddress,
      // Put the direct TailIP in the mobile pairing payload. MagicDNS can be
      // disabled or intercepted by Android private-DNS/OEM VPN settings even
      // while the Tailnet data plane itself is healthy. The relay certificate
      // is fingerprint-pinned by the Android client, so using the TailIP keeps
      // the endpoint private without depending on DNS resolution.
      publicHost: this.tailnet.preferredAddress,
      port: 9443,
      stateDirectory: path.join(this.userDataPath, "tls"),
      relayModulePath,
    });
    await this.startBridge();
    this.log("info", `仅在 Tailnet 地址 ${this.tailnet.preferredAddress}:${this.relay.port} 监听`);
  }

  async startBridge() {
    const generation = ++this.bridgeGeneration;
    const bridgeModulePath = this.resolveModulePath("phodex-bridge", "src", "bridge.js");
    delete require.cache[require.resolve(bridgeModulePath)];
    const { startBridge } = require(bridgeModulePath);
    const codexEnv = await this.providerStore.buildEnvironment(process.env);
    this.policy = createCompanionPolicy({
      projectStore: this.projectStore,
      providerStore: this.providerStore,
      getHostStatus: () => this.publicStatus(),
      allowDangerFullAccess: this.readDesktopSettings().allowDangerFullAccess,
      allowNeverApproval: this.readDesktopSettings().allowNeverApproval,
    });
    this.bridge = startBridge({
      config: {
        relayUrl: this.relay.relayUrl,
        relaySessionId: this.ensureRelaySessionId(),
        relayTlsCa: this.relay.tlsCertificate,
        codexEndpoint: "",
        codexProfile: "",
        codexCommand: this.codex.executable,
        codexConfigOverrides: this.providerStore.buildCodexConfigOverrides(),
        codexEnv,
        refreshEnabled: false,
        desktopAutoFollowEnabled: false,
        desktopIpcLiveSyncEnabled: false,
        keepMacAwakeEnabled: false,
        pushServiceUrl: "",
      },
      printPairingQr: false,
      companionPolicy: this.policy,
      onPairingSession: (session) => {
        void this.updatePairing(session, generation).catch((error) => {
          this.log("warn", `配对二维码生成失败：${error.message}`);
        });
      },
      onBridgeStatus: (status) => {
        if (generation !== this.bridgeGeneration) return;
        this.bridgeStatus = status;
        this.emitState();
      },
    });
  }

  async stop() {
    this.bridgeGeneration += 1;
    clearInterval(this.monitorTimer);
    clearTimeout(this.restartTimer);
    this.monitorTimer = null;
    this.restartTimer = null;
    this.bridge?.stop();
    this.bridge = null;
    await this.relay?.stop();
    this.relay = null;
    this.pairing = null;
    this.bridgeStatus = { state: "stopped", connectionStatus: "disconnected" };
    this.emitState();
  }

  async restartBridge() {
    // Invalidate callbacks before stopping the old instance. Its relay close
    // and QR callbacks can otherwise arrive during the restart window.
    this.bridgeGeneration += 1;
    this.bridge?.stop();
    this.bridge = null;
    await new Promise((resolve) => setTimeout(resolve, 350));
    await this.startBridge();
  }

  async refreshNetwork() {
    if (this.networkRefreshPromise) return this.networkRefreshPromise;
    this.networkRefreshPromise = (async () => {
      try {
        // A failed first launch (for example Codex or Tailscale was not ready)
        // must be recoverable from the tray's Refresh button without restarting
        // Electron.  Re-check the local runtime before rebuilding the stack.
        if (!this.codex) {
          this.codex = await readCodexInstallation();
          this.login = await readCodexLoginStatus({ codexPath: this.codex.executable });
          await this.providerStore.initialize();
        }
        const next = await readTailscaleStatus();
        if (this.tailnet?.preferredAddress !== next.preferredAddress
            || this.tailnet?.dnsName !== next.dnsName
            || !this.relay
            || !this.bridge) {
          this.log("info", "Tailnet 地址变化，正在重建私网监听");
          this.bridge?.stop();
          this.bridge = null;
          await this.relay?.stop();
          this.relay = null;
          this.tailnet = next;
          await this.startNetworkStack();
        } else {
          this.tailnet = next;
        }
      } catch (error) {
        // Do not leave a stale relay/bridge running after Tailscale has gone
        // away.  It would make the desktop UI say "unavailable" while the old
        // socket and QR endpoint remained alive until the OS reclaimed them.
        this.bridge?.stop();
        this.bridge = null;
        await this.relay?.stop().catch(() => {});
        this.relay = null;
        this.pairing = null;
        this.bridgeStatus = { state: "stopped", connectionStatus: "disconnected" };
        this.log("warn", error.message);
        this.tailnet = null;
      } finally {
        this.networkRefreshPromise = null;
        this.emitState();
      }
    })();
    return this.networkRefreshPromise;
  }

  async addProject(projectPath, displayName = "") {
    const project = this.projectStore.add(projectPath, displayName);
    this.emitState();
    return { id: project.id, displayName: project.displayName, pathHint: path.basename(project.path) };
  }

  removeProject(projectId) {
    const removed = this.projectStore.remove(projectId);
    this.emitState();
    return removed;
  }

  async upsertProvider(profile) {
    const result = await this.providerStore.upsert(profile);
    this.emitState();
    return result;
  }

  async deleteProvider(id) {
    const result = await this.providerStore.delete(id);
    this.emitState();
    return result;
  }

  async testProvider(id) {
    const result = await this.providerStore.test(id);
    this.emitState();
    return result;
  }

  async resetTrustedPhone() {
    const secureStatePath = this.resolveModulePath("phodex-bridge", "src", "secure-device-state.js");
    const { resetBridgeTrustState } = require(secureStatePath);
    const result = resetBridgeTrustState();
    this.rotateRelaySessionId();
    await this.restartBridge();
    this.log("info", "已清除可信手机，需要重新扫码");
    return result;
  }

  async updateSecuritySettings(settings) {
    if ((this.policy?.snapshot().activeTurnCount || 0) > 0) {
      throw Object.assign(new Error("请等待当前任务结束后再修改电脑端权限上限。"), {
        code: "turn_in_progress",
      });
    }
    this.settingsStore.write({
      ...this.settingsStore.read(),
      allowDangerFullAccess: settings?.allowDangerFullAccess === true,
      allowNeverApproval: settings?.allowNeverApproval === true,
    });
    await this.restartBridge();
    this.log("warn", "电脑端执行权限上限已更新");
    return this.readDesktopSettings();
  }

  markProviderRestartPending() {
    this.providerRestartPending = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => void this.restartCodexIfIdle(), 500);
    this.emitState();
  }

  async restartCodexIfIdle() {
    if (!this.providerRestartPending || !this.bridge) return;
    if ((this.policy?.snapshot().activeTurnCount || 0) > 0) {
      this.restartTimer = setTimeout(() => void this.restartCodexIfIdle(), 2_000);
      return;
    }
    const env = await this.providerStore.buildEnvironment(process.env);
    const configOverrides = this.providerStore.buildCodexConfigOverrides();
    if (this.bridge.restartCodex({ env, configOverrides })) {
      this.providerRestartPending = false;
      this.log("info", "Provider 已更新，Codex App Server 已在空闲时重启");
      this.emitState();
    }
  }

  async updatePairing(session, generation = this.bridgeGeneration) {
    // A bridge can finish an in-flight QR callback while the network stack is
    // being torn down (for example during Tailnet IP rotation or app exit).
    // Do not dereference a relay that has already been stopped, and do not let
    // a stale QR generation overwrite the newest session.
    const relay = this.relay;
    if (generation !== this.bridgeGeneration || !relay || !session?.pairingPayload) return;
    const pairingPayload = {
      ...session.pairingPayload,
      relay: relay.relayUrl,
      tlsCertSha256: relay.certSha256,
      tlsSpkiSha256: relay.spkiSha256,
      client: "codexlink_android",
    };
    const qrDataUrl = await QRCode.toDataURL(JSON.stringify(pairingPayload), {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 420,
    });
    if (generation !== this.bridgeGeneration || this.relay !== relay || !this.bridge) return;
    this.pairing = { payload: pairingPayload, pairingCode: session.pairingCode, qrDataUrl };
    this.emitState();
  }

  publicStatus() {
    return {
      appVersion: "0.1.0",
      hostName: this.tailnet?.hostName || os.hostname(),
      tailnet: this.tailnet ? {
        state: "Running",
        address: this.tailnet.preferredAddress,
        dnsName: this.tailnet.dnsName,
      } : { state: "Unavailable", address: null, dnsName: null },
      bridge: this.bridgeStatus,
      codex: this.codex ? { version: this.codex.version } : null,
      login: this.login,
      providerRestartPending: this.providerRestartPending,
      permissions: this.readDesktopSettings(),
    };
  }

  snapshot() {
    return {
      status: this.publicStatus(),
      pairing: this.pairing,
      projects: this.projectStore.list(),
      providers: this.providerStore.list(),
      logs: [...this.logs],
    };
  }

  readDesktopSettings() {
    const settings = this.settingsStore.read();
    return {
      allowDangerFullAccess: settings.allowDangerFullAccess === true,
      allowNeverApproval: settings.allowNeverApproval === true,
    };
  }

  ensureRelaySessionId() {
    const settings = this.settingsStore.read();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      String(settings.relaySessionId || "")
    )) {
      return settings.relaySessionId;
    }
    return this.rotateRelaySessionId();
  }

  rotateRelaySessionId() {
    const settings = this.settingsStore.read();
    const relaySessionId = randomUUID();
    this.settingsStore.write({ ...settings, relaySessionId });
    return relaySessionId;
  }

  resolveModulePath(moduleName, ...segments) {
    return path.join(this.appRoot, moduleName, ...segments);
  }

  log(level, message) {
    const safeMessage = String(message || "").replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, "$1…");
    this.logs.push({ at: new Date().toISOString(), level, message: safeMessage });
    this.logs = this.logs.slice(-250);
    this.emitState();
  }

  emitState() {
    this.emit("state", this.snapshot());
  }
}

module.exports = {
  CompanionService,
  MINIMUM_CODEX_VERSION,
  compareVersions,
  execCodex,
  parseVersion,
  readCodexInstallation,
  readCodexLoginStatus,
  resolveCodexExecutable,
};
