const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const {
  compareVersions,
  execCodex,
  parseVersion,
  resolveCodexExecutable,
} = require("../src/main/companion-service");

test("Codex minimum version comparison is numeric", () => {
  assert.deepEqual(parseVersion("codex-cli 0.148.0"), [0, 148, 0]);
  assert.equal(compareVersions("0.147.9", "0.148.0"), -1);
  assert.equal(compareVersions("0.148.0", "0.148.0"), 0);
  assert.equal(compareVersions("1.0.0", "0.148.0"), 1);
});

test("Windows invokes npm-installed Codex through cmd.exe", async () => {
  let invocation;
  await execCodex(["--version"], {
    platform: "win32",
    execFileImpl: async (...args) => { invocation = args; return { stdout: "", stderr: "" }; },
  });
  assert.match(invocation[0], /cmd\.exe$/i);
  assert.deepEqual(invocation[1], ["/d", "/s", "/c", "codex --version"]);
});

test("Windows resolves the native executable behind the npm codex.cmd shim", async () => {
  const shim = "C:\\npm\\codex.cmd";
  const expected = path.win32.join(
    "C:\\npm", "node_modules", "@openai", "codex", "node_modules", "@openai",
    "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"
  );
  const resolved = await resolveCodexExecutable({
    platform: "win32",
    arch: "x64",
    pathImpl: path.win32,
    execFileImpl: async (_command, args) => ({ stdout: args[0] === "codex.cmd" ? `${shim}\r\n` : "" }),
    fsImpl: { existsSync: (candidate) => candidate === expected },
  });
  assert.equal(resolved, expected);
});

test("Windows GUI fallback resolves Codex from the user's npm root without PATH", async () => {
  const expected = path.win32.join(
    "C:\\Users\\tester\\AppData\\Roaming\\npm", "node_modules", "@openai", "codex",
    "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"
  );
  const resolved = await resolveCodexExecutable({
    platform: "win32",
    arch: "x64",
    env: { APPDATA: "C:\\Users\\tester\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
    pathImpl: path.win32,
    execFileImpl: async () => { throw new Error("PATH unavailable"); },
    fsImpl: { existsSync: (candidate) => candidate === expected },
  });
  assert.equal(resolved, expected);
});
