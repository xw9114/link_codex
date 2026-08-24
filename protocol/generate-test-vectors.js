const fs = require("fs");
const path = require("path");
const {
  buildTranscriptBytes,
  deriveAesKey,
  encryptEnvelopePayload,
  nonceForDirection,
} = require("../phodex-bridge/src/secure-transport");

const bytes = (start) => Buffer.from(Array.from({ length: 32 }, (_, index) => (start + index) & 0xff));
const fields = {
  sessionId: "session-vector-001",
  protocolVersion: 2,
  handshakeMode: "qr_bootstrap",
  keyEpoch: 7,
  macDeviceId: "mac-vector-001",
  phoneDeviceId: "phone-vector-001",
  macIdentityPublicKey: bytes(1).toString("base64"),
  phoneIdentityPublicKey: bytes(33).toString("base64"),
  macEphemeralPublicKey: bytes(65).toString("base64"),
  phoneEphemeralPublicKey: bytes(97).toString("base64"),
  clientNonce: bytes(129),
  serverNonce: bytes(161),
  expiresAtForTranscript: 1_900_000_000_000,
};
const transcript = buildTranscriptBytes(fields);
const sharedSecret = bytes(193);
const salt = require("crypto").createHash("sha256").update(transcript).digest();
const prefix = `remodex-e2ee-v1|${fields.sessionId}|${fields.macDeviceId}|${fields.phoneDeviceId}|${fields.keyEpoch}`;
const phoneToMacKey = deriveAesKey(sharedSecret, salt, `${prefix}|phoneToMac`);
const macToPhoneKey = deriveAesKey(sharedSecret, salt, `${prefix}|macToPhone`);
const envelope = encryptEnvelopePayload(
  { bridgeOutboundSeq: 42, payloadText: '{"id":9,"result":{"ok":true}}' },
  macToPhoneKey,
  "mac",
  5,
  fields.sessionId,
  fields.keyEpoch
);

const vector = {
  name: "remodex-v2-fixed-vector-1",
  fields: {
    ...fields,
    clientNonce: fields.clientNonce.toString("base64"),
    serverNonce: fields.serverNonce.toString("base64"),
  },
  sharedSecret: sharedSecret.toString("base64"),
  transcript: transcript.toString("base64"),
  salt: salt.toString("base64"),
  phoneToMacKey: phoneToMacKey.toString("base64"),
  macToPhoneKey: macToPhoneKey.toString("base64"),
  nonces: {
    mac5: nonceForDirection("mac", 5).toString("base64"),
    iphone5: nonceForDirection("iphone", 5).toString("base64"),
  },
  envelope,
};

const output = path.join(__dirname, "test-vectors", "secure-v2.json");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(vector, null, 2)}\n`);
console.log(output);
