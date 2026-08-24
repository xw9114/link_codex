const path = require("path");
const { spawn } = require("child_process");

class WindowsCredentialManager {
  constructor({ helperPath = path.join(__dirname, "..", "..", "scripts", "credential-manager.ps1"), spawnImpl = spawn } = {}) {
    this.helperPath = helperPath;
    this.spawnImpl = spawnImpl;
  }

  set(target, secret) {
    return this.#invoke("set", target, secret);
  }

  get(target) {
    return this.#invoke("get", target).then((value) => value || null);
  }

  delete(target) {
    return this.#invoke("delete", target).then(() => undefined);
  }

  #invoke(action, target, secret = "") {
    if (process.platform !== "win32") {
      return Promise.reject(Object.assign(new Error("Windows Credential Manager is available only on Windows."), {
        code: "credential_manager_unavailable",
      }));
    }
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl("powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", this.helperPath, action, target,
      ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve(stdout.replace(/\r?\n$/, ""));
        } else {
          reject(Object.assign(new Error(stderr.trim() || "Credential Manager operation failed."), {
            code: "credential_manager_failed",
          }));
        }
      });
      if (action === "set") child.stdin.write(secret, "utf8");
      child.stdin.end();
    });
  }
}

class MemoryCredentialManager {
  constructor() { this.values = new Map(); }
  async set(target, secret) { this.values.set(target, secret); }
  async get(target) { return this.values.get(target) || null; }
  async delete(target) { this.values.delete(target); }
}

module.exports = { MemoryCredentialManager, WindowsCredentialManager };
