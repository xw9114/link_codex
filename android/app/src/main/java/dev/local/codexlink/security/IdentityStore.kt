package dev.local.codexlink.security

import java.util.Base64
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters

data class PhoneIdentity(
    val deviceId: String,
    val privateKey: Ed25519PrivateKeyParameters,
) {
    val publicKeyBase64: String = Base64.getEncoder().encodeToString(privateKey.generatePublicKey().encoded)
}

@Singleton
class IdentityStore @Inject constructor(private val secretStore: WrappedSecretStore) {
    fun load(): PhoneIdentity {
        val privateBytes = secretStore.getOrCreate("identity.ed25519", Ed25519PrivateKeyParameters.KEY_SIZE)
        val idBytes = secretStore.get("identity.device-id")
        val deviceId = idBytes?.toString(Charsets.UTF_8) ?: UUID.randomUUID().toString().also {
            secretStore.put("identity.device-id", it.toByteArray(Charsets.UTF_8))
        }
        return PhoneIdentity(deviceId, Ed25519PrivateKeyParameters(privateBytes, 0))
    }
}
