const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { AtomicJsonStore } = require("./atomic-json-store");

function canonicalExistingDirectory(inputPath) {
  if (typeof inputPath !== "string" || !inputPath.trim()) {
    throw Object.assign(new Error("Project path is required."), { code: "invalid_project_path" });
  }
  const resolved = path.resolve(inputPath.trim());
  const real = fs.realpathSync.native(resolved);
  if (!fs.statSync(real).isDirectory()) {
    throw Object.assign(new Error("Project path must be a directory."), { code: "invalid_project_path" });
  }
  return real;
}

function comparablePath(value, platform = process.platform) {
  const normalized = path.normalize(value).replace(/[\\/]+$/, "");
  return platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function isPathInside(rootPath, candidatePath, platform = process.platform) {
  const root = comparablePath(rootPath, platform);
  const candidate = comparablePath(candidatePath, platform);
  if (candidate === root) return true;
  const separator = platform === "win32" ? "\\" : path.sep;
  return candidate.startsWith(`${root}${separator}`);
}

class ProjectStore {
  constructor(filePath) {
    this.store = new AtomicJsonStore(filePath, { projects: [] });
  }

  list() {
    return this.store.read().projects.map(({ id, displayName, path: projectPath }) => ({
      id,
      displayName,
      pathHint: path.basename(projectPath),
    }));
  }

  listInternal() {
    return this.store.read().projects;
  }

  add(projectPath, displayName = "") {
    const canonicalPath = canonicalExistingDirectory(projectPath);
    const state = this.store.read();
    const existing = state.projects.find((project) => (
      comparablePath(project.path) === comparablePath(canonicalPath)
    ));
    if (existing) return { ...existing };

    const project = {
      id: `project_${crypto.randomUUID()}`,
      displayName: displayName.trim() || path.basename(canonicalPath),
      path: canonicalPath,
      addedAt: new Date().toISOString(),
    };
    state.projects.push(project);
    this.store.write(state);
    return { ...project };
  }

  remove(projectId) {
    const state = this.store.read();
    const nextProjects = state.projects.filter((project) => project.id !== projectId);
    if (nextProjects.length === state.projects.length) return false;
    this.store.write({ ...state, projects: nextProjects });
    return true;
  }

  resolve(projectId) {
    const project = this.store.read().projects.find((entry) => entry.id === projectId);
    if (!project) {
      throw Object.assign(new Error("Project is not in the Companion allowlist."), {
        code: "project_not_allowed",
      });
    }
    const canonicalPath = canonicalExistingDirectory(project.path);
    if (comparablePath(canonicalPath) !== comparablePath(project.path)) {
      throw Object.assign(new Error("The allowlisted project now resolves to a different path."), {
        code: "project_identity_changed",
      });
    }
    return { ...project, path: canonicalPath };
  }

  findByCwd(cwd) {
    if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return null;
    let canonicalCandidate;
    try {
      canonicalCandidate = fs.realpathSync.native(cwd);
    } catch {
      return null;
    }
    return this.store.read().projects.find((project) => (
      isPathInside(project.path, canonicalCandidate)
    )) || null;
  }
}

module.exports = {
  ProjectStore,
  canonicalExistingDirectory,
  comparablePath,
  isPathInside,
};
