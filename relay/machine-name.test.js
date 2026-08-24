const assert = require("node:assert/strict");
const test = require("node:test");
const { decodeBase64UrlHeader } = require("./relay");

test("relay decodes the UTF-8 machine-name header", () => {
  const encoded = Buffer.from("开发机-一号", "utf8").toString("base64url");
  assert.equal(decodeBase64UrlHeader(encoded), "开发机-一号");
  assert.equal(decodeBase64UrlHeader("not valid!"), "");
});
