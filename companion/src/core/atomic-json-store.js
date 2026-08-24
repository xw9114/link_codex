const fs = require("fs");
const path = require("path");

class AtomicJsonStore {
  constructor(filePath, defaults = {}) {
    this.filePath = filePath;
    this.defaults = structuredClone(defaults);
  }

  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return { ...structuredClone(this.defaults), ...parsed };
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) {
        return structuredClone(this.defaults);
      }
      throw error;
    }
  }

  write(value) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, this.filePath);
  }
}

module.exports = { AtomicJsonStore };
