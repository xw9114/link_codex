const { execFile } = require("child_process");
const net = require("net");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

function isTailscaleIPv4(address) {
  if (net.isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

function isTailscaleIPv6(address) {
  if (net.isIP(address) !== 6) return false;
  return address.toLowerCase().startsWith("fd7a:115c:a1e0:");
}

function isTailnetAddress(address) {
  return isTailscaleIPv4(address) || isTailscaleIPv6(address);
}

function parseTailscaleStatus(rawStatus) {
  const status = typeof rawStatus === "string" ? JSON.parse(rawStatus) : rawStatus;
  if (!status || status.BackendState !== "Running") {
    const error = new Error("Tailscale is not running.");
    error.code = "tailscale_not_running";
    throw error;
  }

  const addresses = (status.TailscaleIPs || []).filter(isTailnetAddress);
  if (addresses.length === 0) {
    const error = new Error("Tailscale did not report a private Tailnet address.");
    error.code = "tailscale_address_missing";
    throw error;
  }

  const dnsName = String(status.Self?.DNSName || "").replace(/\.$/, "");
  return {
    backendState: status.BackendState,
    addresses,
    preferredAddress: addresses.find(isTailscaleIPv4) || addresses[0],
    dnsName,
    hostName: status.Self?.HostName || "",
    tailnetName: status.MagicDNSSuffix || "",
  };
}

async function readTailscaleStatus({ execFileImpl = execFileAsync } = {}) {
  const { stdout } = await execFileImpl("tailscale", ["status", "--json"], {
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return parseTailscaleStatus(stdout);
}

function assertSafeBindHost(host) {
  if (!host || host === "0.0.0.0" || host === "::" || !isTailnetAddress(host)) {
    const error = new Error("CodexLink may bind only to a Tailscale interface address.");
    error.code = "unsafe_bind_host";
    throw error;
  }
  return host;
}

module.exports = {
  assertSafeBindHost,
  isTailnetAddress,
  isTailscaleIPv4,
  isTailscaleIPv6,
  parseTailscaleStatus,
  readTailscaleStatus,
};
