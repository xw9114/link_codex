package dev.local.codexlink.crypto

import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class TranscriptCodecTest {
    private fun decode(value: String): ByteArray = Base64.getDecoder().decode(value)
    private val vector: Vector by lazy {
        val stream = checkNotNull(javaClass.classLoader?.getResourceAsStream("secure-v2.json"))
        Json { ignoreUnknownKeys = true }.decodeFromString<Vector>(stream.bufferedReader().readText())
    }

    @Test
    fun sharedVectorMatchesTranscriptNonceHkdfAndAesGcm() {
        val f = vector.fields
        val transcript = TranscriptCodec.build(TranscriptFields(
            f.sessionId, f.protocolVersion, f.handshakeMode, f.keyEpoch,
            f.macDeviceId, f.phoneDeviceId,
            decode(f.macIdentityPublicKey), decode(f.phoneIdentityPublicKey),
            decode(f.macEphemeralPublicKey), decode(f.phoneEphemeralPublicKey),
            decode(f.clientNonce), decode(f.serverNonce), f.expiresAtForTranscript,
        ))
        assertArrayEquals(decode(vector.transcript), transcript)
        assertEquals(vector.nonces.mac5, Base64.getEncoder().encodeToString(TranscriptCodec.nonce("mac", 5)))
        assertEquals(vector.nonces.iphone5, Base64.getEncoder().encodeToString(TranscriptCodec.nonce("iphone", 5)))
        val prefix = "$HANDSHAKE_TAG|${f.sessionId}|${f.macDeviceId}|${f.phoneDeviceId}|${f.keyEpoch}"
        assertArrayEquals(decode(vector.phoneToMacKey), TranscriptCodec.hkdf(decode(vector.sharedSecret), decode(vector.salt), "$prefix|phoneToMac"))
        assertArrayEquals(decode(vector.macToPhoneKey), TranscriptCodec.hkdf(decode(vector.sharedSecret), decode(vector.salt), "$prefix|macToPhone"))

        val plaintext = "{\"bridgeOutboundSeq\":42,\"payloadText\":\"{\\\"id\\\":9,\\\"result\\\":{\\\"ok\\\":true}}\"}".toByteArray()
        val encrypted = Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.ENCRYPT_MODE, SecretKeySpec(decode(vector.macToPhoneKey), "AES"), GCMParameterSpec(128, TranscriptCodec.nonce("mac", 5)))
            doFinal(plaintext)
        }
        assertArrayEquals(decode(vector.envelope.ciphertext), encrypted.copyOfRange(0, encrypted.size - 16))
        assertArrayEquals(decode(vector.envelope.tag), encrypted.copyOfRange(encrypted.size - 16, encrypted.size))
    }
}

@Serializable data class Vector(
    val name: String,
    val fields: Fields,
    val sharedSecret: String,
    val transcript: String,
    val salt: String,
    val phoneToMacKey: String,
    val macToPhoneKey: String,
    val nonces: Nonces,
    val envelope: Envelope,
)
@Serializable data class Fields(
    val sessionId: String, val protocolVersion: Int, val handshakeMode: String, val keyEpoch: Long,
    val macDeviceId: String, val phoneDeviceId: String, val macIdentityPublicKey: String,
    val phoneIdentityPublicKey: String, val macEphemeralPublicKey: String, val phoneEphemeralPublicKey: String,
    val clientNonce: String, val serverNonce: String, val expiresAtForTranscript: Long,
)
@Serializable data class Nonces(val mac5: String, val iphone5: String)
@Serializable data class Envelope(val ciphertext: String, val tag: String)
