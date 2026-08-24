// FILE: codex-transport.js
// Purpose: Abstracts the Codex-side transport so the bridge can talk to either a spawned app-server or an existing WebSocket endpoint.
// Layer: CLI helper
// Exports: createCodexTransport
// Depends on: child_process, fs, path, ws

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

function createCodexTransport({
  endpoint = "",
  env = process.env,
  appPath = "",
  profile = "",
  command = "",
  configOverrides = [],
  platform = process.platform,
  spawnImpl = spawn,
  WebSocketImpl = WebSocket,
} = {}) {
  if (endpoint) {
    return createWebSocketTransport({ endpoint, WebSocketImpl });
  }

  return createSpawnTransport({ env, appPath, profile, command, configOverrides, platform, spawnImpl });
}

function createSpawnTransport({ env, appPath, profile, command, configOverrides, platform, spawnImpl = spawn }) {
  let currentEnv = env;
  let currentProfile = profile;
  let currentConfigOverrides = configOverrides;
  let launchPlans = createCodexLaunchPlans({ env: currentEnv, appPath, profile: currentProfile, command, configOverrides: currentConfigOverrides, platform });
  let launchIndex = -1;
  let activeLaunch = null;
  let codex = null;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let didRequestShutdown = false;
  let didRequestRestart = false;
  let didReportError = false;
  const listeners = createListenerBag();

  spawnNextLaunch();

  return {
    mode: "spawn",
    describe() {
      return activeLaunch?.description || launchPlans[0]?.description || "`codex app-server`";
    },
    send(message) {
      if (!codex.stdin.writable || codex.stdin.destroyed || codex.stdin.writableEnded) {
        return;
      }

      codex.stdin.write(message.endsWith("\n") ? message : `${message}\n`);
    },
    onMessage(handler) {
      listeners.onMessage = handler;
    },
    onClose(handler) {
      listeners.onClose = handler;
    },
    onError(handler) {
      listeners.onError = handler;
    },
    onStarted(handler) {
      listeners.onStarted = handler;
    },
    shutdown() {
      didRequestShutdown = true;
      shutdownCodexProcess(codex);
    },
    restart({
      env: nextEnv = currentEnv,
      profile: nextProfile = currentProfile,
      configOverrides: nextConfigOverrides = currentConfigOverrides,
    } = {}) {
      if (didRequestShutdown) {
        throw new Error("Cannot restart a Codex transport after shutdown.");
      }
      currentEnv = nextEnv;
      currentProfile = nextProfile;
      currentConfigOverrides = nextConfigOverrides;
      launchPlans = createCodexLaunchPlans({
        env: currentEnv,
        appPath,
        profile: currentProfile,
        command,
        configOverrides: currentConfigOverrides,
        platform,
      });
      launchIndex = -1;
      didReportError = false;
      didRequestRestart = true;
      if (!codex || codex.killed || codex.exitCode !== null) {
        didRequestRestart = false;
        spawnNextLaunch();
      } else {
        shutdownCodexProcess(codex);
      }
    },
  };

  // Retries the launch once with the bundled desktop binary when the shell-visible
  // `codex` command is unavailable in daemon environments like launchd.
  function spawnNextLaunch() {
    launchIndex += 1;
    activeLaunch = launchPlans[launchIndex] || null;
    if (!activeLaunch) {
      return;
    }

    stdoutBuffer = "";
    stderrBuffer = "";
    codex = spawnImpl(activeLaunch.command, activeLaunch.args, activeLaunch.options);
    attachChildListeners(codex, activeLaunch);
  }

  function attachChildListeners(child, launch) {
    child.on("spawn", () => {
      if (child !== codex) {
        return;
      }

      listeners.emitStarted({
        mode: "spawn",
        launchDescription: launch.description,
      });
    });
    child.on("error", (error) => {
      if (child !== codex) {
        return;
      }

      if (!didRequestShutdown && shouldRetryLaunchError(error, launchIndex, launchPlans)) {
        spawnNextLaunch();
        return;
      }

      didReportError = true;
      listeners.emitError(error);
    });
    child.on("close", (code, signal) => {
      if (child !== codex) {
        return;
      }

      if (didRequestRestart && !didRequestShutdown) {
        didRequestRestart = false;
        spawnNextLaunch();
        return;
      }

      if (!didRequestShutdown && !didReportError && code !== 0) {
        didReportError = true;
        listeners.emitError(createCodexCloseError({
          code,
          signal,
          stderrBuffer,
          launchDescription: launch.description,
        }));
        return;
      }

      listeners.emitClose(code, signal);
    });
    // Ignore broken-pipe shutdown noise once the child is already going away.
    child.stdin.on("error", (error) => {
      if (child !== codex) {
        return;
      }

      if (didRequestShutdown && isIgnorableStdinShutdownError(error)) {
        return;
      }

      if (isIgnorableStdinShutdownError(error)) {
        return;
      }

      didReportError = true;
      listeners.emitError(error);
    });
    // Keep stderr muted during normal operation, but preserve enough output to
    // explain launch failures when the child exits before the bridge can use it.
    child.stderr.on("data", (chunk) => {
      if (child !== codex) {
        return;
      }
      stderrBuffer = appendOutputBuffer(stderrBuffer, chunk.toString("utf8"));
    });

    child.stdout.on("data", (chunk) => {
      if (child !== codex) {
        return;
      }
      stdoutBuffer += chunk.toString("utf8");
      let newlineIndex;
      while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.substring(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.substring(newlineIndex + 1);
        if (line) {
          listeners.emitMessage(line);
        }
      }
    });
  }
}

// Builds a single, platform-aware launch path so the bridge never "guesses"
// between multiple commands and accidentally starts duplicate runtimes.
function createCodexLaunchPlans({
  env,
  appPath = "",
  profile = "",
  command = "",
  configOverrides = [],
  platform = process.platform,
  fsImpl = fs,
  pathImpl = path,
} = {}) {
  const normalizedProfile = typeof profile === "string" ? profile.trim() : "";
  if (normalizedProfile && !/^[A-Za-z0-9_-]+$/.test(normalizedProfile)) {
    throw new Error("Codex profile names may contain only letters, numbers, underscores, and hyphens.");
  }
  const profileArgs = normalizedProfile ? ["--profile", normalizedProfile] : [];
  const normalizedOverrides = Array.isArray(configOverrides)
    ? configOverrides.map((value) => String(value)).filter(Boolean)
    : [];
  const appServerArgs = ["app-server", ...normalizedOverrides.flatMap((value) => ["-c", value])];
  const sharedOptions = {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...env },
  };

  if (command) {
    if (!isLaunchableFile(command, { fsImpl })) {
      throw new Error(`Configured Codex executable does not exist: ${command}`);
    }
    return [{
      command,
      args: appServerArgs,
      options: { ...sharedOptions, windowsHide: platform === "win32" },
      description: `\`${command} app-server\``,
    }];
  }

  if (platform === "win32") {
    if (normalizedOverrides.length > 0) {
      throw new Error("Codex config overrides on Windows require a resolved native Codex executable.");
    }
    return [{
      command: env.ComSpec || "cmd.exe",
      args: ["/d", "/c", `codex ${normalizedProfile ? `--profile ${normalizedProfile} ` : ""}app-server`],
      options: {
        ...sharedOptions,
        windowsHide: true,
      },
      description: `\`cmd.exe /d /c codex ${normalizedProfile ? `--profile ${normalizedProfile} ` : ""}app-server\``,
    }];
  }

  const launches = [{
    command: "codex",
    args: [...profileArgs, ...appServerArgs],
    options: sharedOptions,
    description: `\`codex ${normalizedProfile ? `--profile ${normalizedProfile} ` : ""}app-server\``,
  }];

  const bundledCommand = buildBundledCodexPath(appPath, { fsImpl, pathImpl });
  if (bundledCommand) {
    launches.push({
      command: bundledCommand,
      args: [...profileArgs, ...appServerArgs],
      options: sharedOptions,
      description: `\`${bundledCommand} ${normalizedProfile ? `--profile ${normalizedProfile} ` : ""}app-server\``,
    });
  }

  return launches;
}

function buildBundledCodexPath(appPath, { fsImpl = fs, pathImpl = path } = {}) {
  if (typeof appPath !== "string" || !appPath.trim()) {
    return "";
  }

  const candidate = pathImpl.join(appPath.trim(), "Contents", "Resources", "codex");
  return isLaunchableFile(candidate, { fsImpl }) ? candidate : "";
}

function isLaunchableFile(candidatePath, { fsImpl = fs } = {}) {
  try {
    return fsImpl.statSync(candidatePath).isFile();
  } catch {
    return false;
  }
}

// Stops the exact process tree we launched on Windows so the shell wrapper
// does not leave a child Codex process running in the background.
function shutdownCodexProcess(codex) {
  if (codex.killed || codex.exitCode !== null) {
    return;
  }

  if (process.platform === "win32" && codex.pid) {
    const killer = spawn("taskkill", ["/pid", String(codex.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => {
      codex.kill();
    });
    return;
  }

  codex.kill("SIGTERM");
}

function createCodexCloseError({ code, signal, stderrBuffer, launchDescription }) {
  const details = stderrBuffer.trim();
  const reason = details || `Process exited with code ${code}${signal ? ` (signal: ${signal})` : ""}.`;
  return new Error(formatCodexLaunchFailure({
    launchDescription,
    reason,
  }));
}

// Turns common Codex auth/config failures into recovery guidance without handling secrets in Remodex.
function formatCodexLaunchFailure({ launchDescription, reason }) {
  const message = `Codex launcher ${launchDescription} failed: ${reason}`;
  const missingEnvVar = extractMissingEnvironmentVariable(reason);
  if (!missingEnvVar) {
    return message;
  }

  const guidance = [
    `Codex is asking for ${missingEnvVar}, which usually means your Codex config forces API-key auth or a custom provider env var.`,
    "Remodex does not store or forward OpenAI API keys.",
    "Recommended fix: run `codex login` on this Mac, then restart Remodex.",
    "If you intentionally use API-key auth, run `printenv OPENAI_API_KEY | codex login --with-api-key` or make that env var available to the Remodex daemon yourself.",
  ];
  return `${message}\n${guidance.join("\n")}`;
}

function extractMissingEnvironmentVariable(reason) {
  const match = String(reason || "").match(/Missing environment variable:\s*`?([A-Za-z_][A-Za-z0-9_]*)`?/i);
  return match ? match[1] : "";
}

function appendOutputBuffer(buffer, chunk) {
  const next = `${buffer}${chunk}`;
  return next.slice(-4_096);
}

function isIgnorableStdinShutdownError(error) {
  return error?.code === "EPIPE" || error?.code === "ERR_STREAM_DESTROYED";
}

function shouldRetryLaunchError(error, launchIndex, launchPlans) {
  return error?.code === "ENOENT" && launchIndex < launchPlans.length - 1;
}

function createWebSocketTransport({ endpoint, WebSocketImpl = WebSocket }) {
  const socket = new WebSocketImpl(endpoint);
  const listeners = createListenerBag();
  const openState = WebSocketImpl.OPEN ?? WebSocket.OPEN ?? 1;
  const connectingState = WebSocketImpl.CONNECTING ?? WebSocket.CONNECTING ?? 0;

  socket.on("message", (chunk) => {
    const message = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (message.trim()) {
      listeners.emitMessage(message);
    }
  });
  socket.on("open", () => {
    listeners.emitStarted({
      mode: "websocket",
      launchDescription: endpoint,
    });
  });

  socket.on("close", (code, reason) => {
    const safeReason = reason ? reason.toString("utf8") : "no reason";
    listeners.emitClose(code, safeReason);
  });

  socket.on("error", (error) => listeners.emitError(error));

  return {
    mode: "websocket",
    describe() {
      return endpoint;
    },
    send(message) {
      if (socket.readyState === openState) {
        socket.send(message);
      }
    },
    onMessage(handler) {
      listeners.onMessage = handler;
    },
    onClose(handler) {
      listeners.onClose = handler;
    },
    onError(handler) {
      listeners.onError = handler;
    },
    onStarted(handler) {
      listeners.onStarted = handler;
    },
    shutdown() {
      if (socket.readyState === openState || socket.readyState === connectingState) {
        socket.close();
      }
    },
  };
}

function createListenerBag() {
  return {
    onMessage: null,
    onClose: null,
    onError: null,
    onStarted: null,
    emitMessage(message) {
      this.onMessage?.(message);
    },
    emitClose(...args) {
      this.onClose?.(...args);
    },
    emitError(error) {
      this.onError?.(error);
    },
    emitStarted(info) {
      this.onStarted?.(info);
    },
  };
}

module.exports = {
  createCodexLaunchPlans,
  createCodexTransport,
  extractMissingEnvironmentVariable,
  formatCodexLaunchFailure,
};
