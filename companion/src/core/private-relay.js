const path = require("path");
const { assertSafeBindHost } = require("./tailscale");
const { loadOrCreateTlsIdentity } = require("./tls-identity");

function resolveRelayModule(customPath = "") {
  const relayPath = customPath || path.resolve(__dirname, "..", "..", "..", "relay", "server.js");
  return require(relayPath);
}

async function startPrivateRelay({
  bindHost,
  publicHost = "",
  port = 9443,
  stateDirectory,
  relayModulePath = "",
  relayOptions = {},
}) {
  const safeHost = assertSafeBindHost(bindHost);
  const identity = await loadOrCreateTlsIdentity({
    directory: stateDirectory,
    dnsName: publicHost && publicHost !== safeHost ? publicHost : "",
    ipAddress: safeHost,
  });
  const { createRelayServer } = resolveRelayModule(relayModulePath);
  const { server, wss } = createRelayServer({
    enablePushService: false,
    exposeDetailedHealth: false,
    relayOptions,
    tlsOptions: { cert: identity.cert, key: identity.key, minVersion: "TLSv1.2" },
    trustProxy: false,
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, safeHost);
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const urlHost = publicHost || safeHost;
  const bracketedHost = urlHost.includes(":") ? `[${urlHost}]` : urlHost;
  return {
    bindHost: safeHost,
    port: actualPort,
    relayUrl: `wss://${bracketedHost}:${actualPort}/relay`,
    certSha256: identity.certSha256,
    spkiSha256: identity.spkiSha256,
    tlsCertificate: identity.cert,
    stop: () => new Promise((resolve) => {
      for (const client of wss.clients) client.close(1001, "Companion stopping");
      server.close(() => resolve());
    }),
  };
}

module.exports = { startPrivateRelay };
