package dev.local.codexlink.network

import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager
import okhttp3.OkHttpClient

class CompanionPinTrustManager(
    private val expectedCertificateSha256: ByteArray,
    private val expectedSpkiSha256: ByteArray,
) : X509TrustManager {
    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        val certificate = chain?.firstOrNull() ?: throw java.security.cert.CertificateException("Missing Companion certificate")
        val digest = MessageDigest.getInstance("SHA-256")
        val certificatePin = digest.digest(certificate.encoded)
        val spkiPin = digest.digest(certificate.publicKey.encoded)
        if (!MessageDigest.isEqual(certificatePin, expectedCertificateSha256)
            || !MessageDigest.isEqual(spkiPin, expectedSpkiSha256)) {
            throw java.security.cert.CertificateException("Companion TLS fingerprint changed")
        }
        certificate.checkValidity()
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

fun OkHttpClient.withCompanionPin(certSha256: ByteArray, spkiSha256: ByteArray): OkHttpClient {
    val trustManager = CompanionPinTrustManager(certSha256, spkiSha256)
    val context = SSLContext.getInstance("TLS").apply {
        init(null, arrayOf<TrustManager>(trustManager), SecureRandom())
    }
    return newBuilder()
        .sslSocketFactory(context.socketFactory, trustManager)
        // Hostname verification is bound to the exact pinned leaf certificate above.
        .hostnameVerifier { _, session ->
            runCatching {
                val certificate = session.peerCertificates.first() as X509Certificate
                MessageDigest.isEqual(MessageDigest.getInstance("SHA-256").digest(certificate.encoded), certSha256)
            }.getOrDefault(false)
        }
        .build()
}
