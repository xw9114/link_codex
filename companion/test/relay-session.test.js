const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { CompanionService } = require("../src/main/companion-service");

test("Companion keeps one relay session across restarts and rotates it on trust reset", () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "codexlink-session-"));
  try {
    const firstService = new CompanionService({ userDataPath, appRoot: process.cwd() });
    const first = firstService.ensureRelaySessionId();
    const restartedService = new CompanionService({ userDataPath, appRoot: process.cwd() });
    assert.equal(restartedService.ensureRelaySessionId(), first);

    const rotated = restartedService.rotateRelaySessionId();
    assert.notEqual(rotated, first);
    assert.equal(new CompanionService({ userDataPath, appRoot: process.cwd() }).ensureRelaySessionId(), rotated);
  } finally {
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});
