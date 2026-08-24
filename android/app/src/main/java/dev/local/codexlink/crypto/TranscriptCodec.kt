package dev.local.codexlink.crypto

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.params.HKDFParameters

const val HANDSHAKE_TAG = "remodex-e2ee-v1"
const val SECURE_PROTOCOL_VERSION = 2

data class TranscriptFields(
    val sessionId: String,
    val protocolVersion: Int,
    val handshakeMode: String,
    val keyEpoch: Long,
    val macDeviceId: String,
    val phoneDeviceId: String,
    val macIdentityPublicKey: ByteArray,
    val phoneIdentityPublicKey: ByteArray,
    val macEphemeralPublicKey: ByteArray,
    val phoneEphemeralPublicKey: ByteArray,
    val clientNonce: ByteArray,
    val serverNonce: ByteArray,
    val expiresAtForTranscript: Long,
)

object TranscriptCodec {
    fun build(fields: TranscriptFields): ByteArray = ByteArrayOutputStream().apply {
        writePart(HANDSHAKE_TAG.toByteArray())
        writePart(fields.sessionId.toByteArray())
        writePart(fields.protocolVersion.toString().toByteArray())
        writePart(fields.handshakeMode.toByteArray())
        writePart(fields.keyEpoch.toString().toByteArray())
        writePart(fields.macDeviceId.toByteArray())
        writePart(fields.phoneDeviceId.toByteArray())
        writePart(fields.macIdentityPublicKey)
        writePart(fields.phoneIdentityPublicKey)
        writePart(fields.macEphemeralPublicKey)
        writePart(fields.phoneEphemeralPublicKey)
        writePart(fields.clientNonce)
        writePart(fields.serverNonce)
        writePart(fields.expiresAtForTranscript.toString().toByteArray())
    }.toByteArray()

    fun appendLabel(transcript: ByteArray, label: String): ByteArray = ByteArrayOutputStream().apply {
        write(transcript)
        writePart(label.toByteArray())
    }.toByteArray()

    fun nonce(sender: String, counter: Long): ByteArray {
        require(counter >= 0) { "Counter must not be negative" }
        val nonce = ByteArray(12)
        nonce[0] = if (sender == "mac") 1 else 2
        var value = counter
        for (index in 11 downTo 1) {
            nonce[index] = (value and 0xff).toByte()
            value = value ushr 8
        }
        return nonce
    }

    fun sha256(value: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(value)

    fun hkdf(sharedSecret: ByteArray, salt: ByteArray, info: String): ByteArray {
        val output = ByteArray(32)
        HKDFBytesGenerator(SHA256Digest()).apply {
            init(HKDFParameters(sharedSecret, salt, info.toByteArray()))
            generateBytes(output, 0, output.size)
        }
        return output
    }

    private fun ByteArrayOutputStream.writePart(value: ByteArray) {
        write(ByteBuffer.allocate(4).order(ByteOrder.BIG_ENDIAN).putInt(value.size).array())
        write(value)
    }
}
