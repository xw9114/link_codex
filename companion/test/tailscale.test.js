const assert = require("node:assert/strict");
const test = require("node:test");
const {
  assertSafeBindHost,
  isTailnetAddress,
  parseTailscaleStatus,
} = require("../src/core/tailscale");

test("accepts only CGNAT and Tailscale ULA addresses", () => {
  assert.equal(isTailnetAddress("100.64.0.1"), true);
  assert.equal(isTailnetAddress("100.127.255.254"), true);
  assert.equal(isTailnetAddress("100.128.0.1"), false);
  assert.equal(isTailnetAddress("fd7a:115c:a1e0::1"), true);
  assert.equal(isTailnetAddress("127.0.0.1"), false);
  assert.throws(() => assertSafeBindHost("0.0.0.0"), { code: "unsafe_bind_host" });
  assert.throws(() => assertSafeBindHost("192.168.1.4"), { code: "unsafe_bind_host" });
});

test("parses a running Tailscale status without accepting unrelated addresses", () => {
  const status = parseTailscaleStatus({
    BackendState: "Running",
    TailscaleIPs: ["192.168.1.10", "fd7a:115c:a1e0::42", "100.72.3.4"],
    Self: { DNSName: "desktop.tail.example.ts.net.", HostName: "desktop" },
    MagicDNSSuffix: "tail.example.ts.net",
  });
  assert.equal(status.preferredAddress, "100.72.3.4");
  assert.deepEqual(status.addresses, ["fd7a:115c:a1e0::42", "100.72.3.4"]);
  assert.equal(status.dnsName, "desktop.tail.example.ts.net");
});

test("rejects a stopped or address-less daemon", () => {
  assert.throws(() => parseTailscaleStatus({ BackendState: "Stopped" }), { code: "tailscale_not_running" });
  assert.throws(() => parseTailscaleStatus({ BackendState: "Running", TailscaleIPs: [] }), {
    code: "tailscale_address_missing",
  });
});
