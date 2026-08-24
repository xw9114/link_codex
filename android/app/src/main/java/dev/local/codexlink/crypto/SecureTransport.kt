package dev.local.codexlink.crypto

import dev.local.codexlink.data.PairingPayload
import dev.local.codexlink.security.PhoneIdentity
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer

sealed interface SecureEvent {
    data class SendWire(val text: String) : SecureEvent
    data class Application(val text: String, val bridgeOutboundSeq: Long?, val bridgeReplayEpoch: String) : SecureEvent
    data class Ready(val bridgeReplayEpoch: String) : SecureEvent
    data class Error(val code: String, val message: String) : SecureEvent
}

data class ReplayCursor(val sequence: Long = 0, val epoch: String = "")

class SecureTransport(
    private val identity: PhoneIdentity,
    private val json: Json = Json { ignoreUnknownKeys = true },
    private val random: SecureRandom = SecureRandom(),
) {
    private var pairing: PairingPayload? = null
    private var handshakeMode = ""
    private var ephemeral: X25519PrivateKeyParameters? = null
    private var clientNonce = ByteArray(0)
    private var transcript = ByteArray(0)
    private var keyEpoch = 0L
    private var phoneToMacKey = ByteArray(0)
    private var macToPhoneKey = ByteArray(0)
    private var nextOutboundCounter = 0L
    private var lastInboundCounter = -1L
    private var replayCursor = ReplayCursor()
    private var bridgeReplayEpoch = ""
    private var ready = false

    fun begin(pairingPayload: PairingPayload, trustedReconnect: Boolean, cursor: ReplayCursor): String {
        require(pairingPayload.v == 2) { "Unsupported pairing version" }
        if (!trustedReconnect) require(System.currentTimeMillis() <= pairingPayload.expiresAt) { "Pairing QR has expired" }
        pairing = pairingPayload
        handshakeMode = if (trustedReconnect) "trusted_reconnect" else "qr_bootstrap"
        ephemeral = X25519PrivateKeyParameters(random)
        clientNonce = ByteArray(32).also(random::nextBytes)
        replayCursor = cursor
        keyEpoch = 0
        nextOutboundCounter = 0
        lastInboundCounter = -1
        ready = false
        return buildJsonObject {
            put("kind", "clientHello")
            put("protocolVersion", SECURE_PROTOCOL_VERSION)
            put("sessionId", pairingPayload.sessionId)
            put("handshakeMode", handshakeMode)
            put("phoneDeviceId", identity.deviceId)
            put("phoneIdentityPublicKey", identity.publicKeyBase64)
            put("phoneEphemeralPublicKey", b64(ephemeral!!.generatePublicKey().encoded))
            put("clientNonce", b64(clientNonce))
        }.toString()
    }

    fun handleWire(raw: String): List<SecureEvent> = runCatching {
        val message = json.parseToJsonElement(raw).jsonObject
        when (message.string("kind")) {
            "serverHello" -> handleServerHello(message)
            "secureReady" -> handleSecureReady(message)
            "encryptedEnvelope" -> handleEncryptedEnvelope(message)
            "secureError" -> listOf(SecureEvent.Error(message.string("code"), message.string("message")))
            else -> emptyList()
        }
    }.getOrElse { listOf(SecureEvent.Error("invalid_wire_message", it.message ?: "Invalid secure message")) }

    fun encryptApplication(payloadText: String): String {
        check(ready) { "Secure channel is not ready" }
        val payload = buildJsonObject { put("payloadText", payloadText) }.toString().toByteArray()
        val encrypted = encrypt(phoneToMacKey, "iphone", nextOutboundCounter, payload)
        return envelope("iphone", nextOutboundCounter++, encrypted.first, encrypted.second)
    }

    fun isReady(): Boolean = ready

    private fun handleServerHello(message: JsonObject): List<SecureEvent> {
        val pairing = requireNotNull(pairing)
        require(message.int("protocolVersion") == SECURE_PROTOCOL_VERSION)
        require(message.string("sessionId") == pairing.sessionId)
        require(message.string("handshakeMode") == handshakeMode)
        require(message.string("macDeviceId") == pairing.macDeviceId)
        require(message.string("macIdentityPublicKey") == pairing.macIdentityPublicKey)
        require(message.string("clientNonce") == b64(clientNonce))
        keyEpoch = message.long("keyEpoch")
        bridgeReplayEpoch = message.string("bridgeReplayEpoch")
        val macEphemeral = decode(message.string("macEphemeralPublicKey"))
        val serverNonce = decode(message.string("serverNonce"))
        val expiresAtForTranscript = message.long("expiresAtForTranscript")
        if (handshakeMode == "qr_bootstrap") require(expiresAtForTranscript == pairing.expiresAt)
        else require(expiresAtForTranscript == 0L)

        transcript = TranscriptCodec.build(
            TranscriptFields(
                pairing.sessionId,
                SECURE_PROTOCOL_VERSION,
                handshakeMode,
                keyEpoch,
                pairing.macDeviceId,
                identity.deviceId,
                decode(pairing.macIdentityPublicKey),
                decode(identity.publicKeyBase64),
                macEphemeral,
                ephemeral!!.generatePublicKey().encoded,
                clientNonce,
                serverNonce,
                expiresAtForTranscript,
            )
        )
        require(verify(decode(pairing.macIdentityPublicKey), transcript, decode(message.string("macSignature")))) {
            "Companion identity signature is invalid"
        }
        val sharedSecret = ByteArray(32)
        ephemeral!!.generateSecret(X25519PublicKeyParameters(macEphemeral, 0), sharedSecret, 0)
        val salt = TranscriptCodec.sha256(transcript)
        val prefix = "$HANDSHAKE_TAG|${pairing.sessionId}|${pairing.macDeviceId}|${identity.deviceId}|$keyEpoch"
        phoneToMacKey = TranscriptCodec.hkdf(sharedSecret, salt, "$prefix|phoneToMac")
        macToPhoneKey = TranscriptCodec.hkdf(sharedSecret, salt, "$prefix|macToPhone")
        sharedSecret.fill(0)
        val signature = sign(TranscriptCodec.appendLabel(transcript, "client-auth"))
        return listOf(SecureEvent.SendWire(buildJsonObject {
            put("kind", "clientAuth")
            put("sessionId", pairing.sessionId)
            put("phoneDeviceId", identity.deviceId)
            put("keyEpoch", keyEpoch)
            put("phoneSignature", b64(signature))
        }.toString()))
    }

    private fun handleSecureReady(message: JsonObject): List<SecureEvent> {
        val pairing = requireNotNull(pairing)
        require(message.string("sessionId") == pairing.sessionId)
        require(message.long("keyEpoch") == keyEpoch)
        ready = true
        val resume = buildJsonObject {
            put("kind", "resumeState")
            put("sessionId", pairing.sessionId)
            put("keyEpoch", keyEpoch)
            put("lastAppliedBridgeOutboundSeq", replayCursor.sequence)
            put("bridgeReplayEpoch", replayCursor.epoch)
        }.toString()
        return listOf(SecureEvent.SendWire(resume), SecureEvent.Ready(bridgeReplayEpoch))
    }

    private fun handleEncryptedEnvelope(message: JsonObject): List<SecureEvent> {
        check(ready)
        val pairing = requireNotNull(pairing)
        require(message.string("sessionId") == pairing.sessionId)
        require(message.long("keyEpoch") == keyEpoch)
        require(message.string("sender") == "mac")
        val counter = message.long("counter")
        require(counter == lastInboundCounter + 1) { "Repeated or out-of-order envelope" }
        val plaintext = decrypt(
            macToPhoneKey,
            "mac",
            counter,
            decode(message.string("ciphertext")),
            decode(message.string("tag")),
        )
        lastInboundCounter = counter
        val payload = json.parseToJsonElement(plaintext.toString(Charsets.UTF_8)).jsonObject
        return listOf(SecureEvent.Application(
            text = payload.string("payloadText"),
            bridgeOutboundSeq = payload["bridgeOutboundSeq"]?.jsonPrimitive?.long,
            bridgeReplayEpoch = bridgeReplayEpoch,
        ))
    }

    private fun encrypt(key: ByteArray, sender: String, counter: Long, plaintext: ByteArray): Pair<ByteArray, ByteArray> {
        val result = Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, TranscriptCodec.nonce(sender, counter)))
            doFinal(plaintext)
        }
        return result.copyOfRange(0, result.size - 16) to result.copyOfRange(result.size - 16, result.size)
    }

    private fun decrypt(key: ByteArray, sender: String, counter: Long, ciphertext: ByteArray, tag: ByteArray): ByteArray =
        Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, TranscriptCodec.nonce(sender, counter)))
            doFinal(ciphertext + tag)
        }

    private fun envelope(sender: String, counter: Long, ciphertext: ByteArray, tag: ByteArray): String = buildJsonObject {
        put("kind", "encryptedEnvelope")
        put("v", SECURE_PROTOCOL_VERSION)
        put("sessionId", requireNotNull(pairing).sessionId)
        put("keyEpoch", keyEpoch)
        put("sender", sender)
        put("counter", counter)
        put("ciphertext", b64(ciphertext))
        put("tag", b64(tag))
    }.toString()

    private fun sign(value: ByteArray): ByteArray = Ed25519Signer().run {
        init(true, identity.privateKey)
        update(value, 0, value.size)
        generateSignature()
    }

    private fun verify(publicKey: ByteArray, value: ByteArray, signature: ByteArray): Boolean = Ed25519Signer().run {
        init(false, Ed25519PublicKeyParameters(publicKey, 0))
        update(value, 0, value.size)
        verifySignature(signature)
    }

    private fun JsonObject.string(name: String): String = getValue(name).jsonPrimitive.content
    private fun JsonObject.long(name: String): Long = getValue(name).jsonPrimitive.long
    private fun JsonObject.int(name: String): Int = getValue(name).jsonPrimitive.content.toInt()
    private fun b64(value: ByteArray): String = Base64.getEncoder().encodeToString(value)
    private fun decode(value: String): ByteArray = Base64.getDecoder().decode(value)
}
