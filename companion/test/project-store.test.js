const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ProjectStore, isPathInside } = require("../src/core/project-store");

test("project ids resolve to canonical allowlisted directories", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codexlink-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectPath = path.join(root, "Project");
  const outsidePath = path.join(root, "Outside");
  fs.mkdirSync(path.join(projectPath, "src"), { recursive: true });
  fs.mkdirSync(outsidePath);
  const store = new ProjectStore(path.join(root, "projects.json"));
  const project = store.add(path.join(projectPath, ".", "src", ".."));
  assert.equal(store.resolve(project.id).path, fs.realpathSync.native(projectPath));
  assert.equal(store.findByCwd(path.join(projectPath, "src")).id, project.id);
  assert.equal(store.findByCwd(outsidePath), null);
  assert.throws(() => store.resolve("project_unknown"), { code: "project_not_allowed" });
});

test("path boundary comparison does not confuse sibling prefixes", () => {
  assert.equal(isPathInside("C:\\code\\app", "C:\\code\\app2", "win32"), false);
  assert.equal(isPathInside("C:\\code\\app", "c:\\CODE\\APP\\src", "win32"), true);
});

test("junction aliases collapse to the same project identity", { skip: process.platform !== "win32" }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codexlink-junction-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "target");
  const alias = path.join(root, "alias");
  fs.mkdirSync(target);
  fs.symlinkSync(target, alias, "junction");
  const store = new ProjectStore(path.join(root, "projects.json"));
  const first = store.add(target);
  const second = store.add(alias);
  assert.equal(first.id, second.id);
  assert.equal(store.list().length, 1);
});
