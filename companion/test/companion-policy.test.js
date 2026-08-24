const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createCompanionPolicy } = require("../src/core/companion-policy");
const { ProjectStore } = require("../src/core/project-store");

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codexlink-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const allowed = path.join(root, "allowed");
  const outside = path.join(root, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  const projectStore = new ProjectStore(path.join(root, "projects.json"));
  const project = projectStore.add(allowed);
  const providerStore = {
    list: () => [],
    resolveForThread: () => ({ providerId: "chatgpt", modelProvider: null, defaultModel: null }),
  };
  const policy = createCompanionPolicy({ projectStore, providerStore });
  const sent = [];
  const forwarded = [];
  const context = { sendResponse: (value) => sent.push(JSON.parse(value)), forward: (value) => forwarded.push(JSON.parse(value)) };
  return { allowed, outside, project, projectStore, policy, sent, forwarded, context };
}

test("thread/start replaces mobile paths and enforces desktop permission ceiling", (t) => {
  const f = createFixture(t);
  f.policy.handleInbound(JSON.stringify({
    id: 1,
    method: "thread/start",
    params: { projectId: f.project.id, cwd: f.outside, sandbox: "workspace-write", approvalPolicy: "on-request" },
  }), f.context);
  assert.equal(f.forwarded[0].params.cwd, fs.realpathSync.native(f.allowed));
  assert.equal("projectId" in f.forwarded[0].params, false);

  f.policy.handleInbound(JSON.stringify({
    id: 2,
    method: "thread/start",
    params: { projectId: f.project.id, sandbox: "danger-full-access" },
  }), f.context);
  assert.equal(f.sent.at(-1).error.code, "sandbox_exceeds_host_limit");
});

test("thread list removes history outside the allowlist and gates later requests", (t) => {
  const f = createFixture(t);
  f.policy.handleInbound(JSON.stringify({ id: 10, method: "thread/list", params: {} }), f.context);
  const filtered = JSON.parse(f.policy.filterOutbound(JSON.stringify({
    id: 10,
    result: { data: [
      { id: "allowed-thread", cwd: f.allowed },
      { id: "outside-thread", cwd: f.outside },
    ] },
  })));
  assert.deepEqual(filtered.result.data.map((thread) => thread.id), ["allowed-thread"]);

  f.policy.handleInbound(JSON.stringify({ id: 11, method: "thread/read", params: { threadId: "outside-thread" } }), f.context);
  assert.equal(f.sent.at(-1).error.code, "thread_not_allowed");
  f.policy.handleInbound(JSON.stringify({ id: 12, method: "turn/start", params: { threadId: "allowed-thread" } }), f.context);
  assert.equal(f.forwarded.at(-1).params.cwd, fs.realpathSync.native(f.allowed));
});

test("raw filesystem and command methods are blocked", (t) => {
  const f = createFixture(t);
  for (const method of ["project/browse", "workspace/read", "fs/read", "process/spawn", "command/exec"]) {
    f.policy.handleInbound(JSON.stringify({ id: method, method, params: {} }), f.context);
    assert.equal(f.sent.at(-1).error.code, "method_not_allowed");
  }
});

test("thread resume cannot override the allowlisted cwd or provider", (t) => {
  const f = createFixture(t);
  f.policy.handleInbound(JSON.stringify({ id: 20, method: "thread/list", params: {} }), f.context);
  f.policy.filterOutbound(JSON.stringify({
    id: 20,
    result: { data: [{ id: "allowed-thread", cwd: f.allowed }] },
  }));

  f.policy.handleInbound(JSON.stringify({
    id: 21,
    method: "thread/resume",
    params: {
      threadId: "allowed-thread",
      cwd: f.outside,
      providerId: "attacker-provider",
      modelProvider: "attacker-provider",
    },
  }), f.context);

  assert.equal(f.forwarded.at(-1).params.cwd, fs.realpathSync.native(f.allowed));
  assert.equal("providerId" in f.forwarded.at(-1).params, false);
  assert.equal("modelProvider" in f.forwarded.at(-1).params, false);
});

test("thread-bound requests fail cleanly after the project is removed", (t) => {
  const f = createFixture(t);
  f.policy.handleInbound(JSON.stringify({ id: 30, method: "thread/list", params: {} }), f.context);
  f.policy.filterOutbound(JSON.stringify({
    id: 30,
    result: { data: [{ id: "allowed-thread", cwd: f.allowed }] },
  }));
  // Removing the project through the same store used by the policy models the
  // desktop allowlist UI. The stale thread authorization must not throw.
  f.projectStore.remove(f.project.id);
  f.policy.handleInbound(JSON.stringify({ id: 31, method: "thread/read", params: { threadId: "allowed-thread" } }), f.context);
  assert.equal(f.sent.at(-1).error.code, "project_not_allowed");
});
