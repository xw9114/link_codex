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

  let stopPromise = null;
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      // `server.close()` does not close a noServer WebSocketServer. Leaving it
      // open leaks the relay heartbeat interval on every TailIP/sleep restart.
      for (const client of wss.clients) client.terminate();
      await Promise.all([
        new Promise((resolve) => {
          try { wss.close(() => resolve()); } catch { resolve(); }
        }),
        new Promise((resolve) => {
          if (!server.listening) return resolve();
          server.close(() => resolve());
        }),
      ]);
    })();
    return stopPromise;
  };

  try {
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
  } catch (error) {
    // A bind failure (most often EADDRINUSE) happens after the WebSocketServer
    // has created its heartbeat timer. Clean both resources before surfacing
    // the startup error so a failed launch cannot keep Electron alive.
    await stop();
    throw error;
  }

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
    stop,
  };
}

module.exports = { startPrivateRelay };
