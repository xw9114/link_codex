const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const selfsigned = require("selfsigned");

function sha256Base64(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("base64");
}

function describeCertificate(certPem) {
  const certificate = new crypto.X509Certificate(certPem);
  const spki = certificate.publicKey.export({ type: "spki", format: "der" });
  return {
    certSha256: sha256Base64(certificate.raw),
    spkiSha256: sha256Base64(spki),
    validTo: certificate.validTo,
  };
}

async function loadOrCreateTlsIdentity({ directory, dnsName = "", ipAddress }) {
  fs.mkdirSync(directory, { recursive: true });
  const certPath = path.join(directory, "tailnet-cert.pem");
  const keyPath = path.join(directory, "tailnet-key.pem");
  let cert;
  let key;
  try {
    cert = fs.readFileSync(certPath, "utf8");
    key = fs.readFileSync(keyPath, "utf8");
    const x509 = new crypto.X509Certificate(cert);
    if (new Date(x509.validTo).getTime() <= Date.now() + 24 * 60 * 60 * 1000) {
      throw new Error("certificate_expiring");
    }
  } catch {
    const altNames = [];
    if (dnsName) altNames.push({ type: 2, value: dnsName });
    if (ipAddress) altNames.push({ type: 7, ip: ipAddress });
    const generated = await selfsigned.generate([
      { name: "commonName", value: dnsName || ipAddress || "codexlink.local" },
      { name: "organizationName", value: "CodexLink Local" },
    ], {
      algorithm: "sha256",
      days: 3650,
      keySize: 2048,
      extensions: [
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames },
      ],
    });
    cert = generated.cert;
    key = generated.private;
    fs.writeFileSync(keyPath, key, { encoding: "utf8", mode: 0o600 });
    fs.writeFileSync(certPath, cert, { encoding: "utf8", mode: 0o600 });
  }
  return { cert, key, certPath, keyPath, ...describeCertificate(cert) };
}

module.exports = { describeCertificate, loadOrCreateTlsIdentity, sha256Base64 };
