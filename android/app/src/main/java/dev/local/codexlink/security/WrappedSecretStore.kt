package dev.local.codexlink.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import dagger.hilt.android.qualifiers.ApplicationContext
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class WrappedSecretStore @Inject constructor(@ApplicationContext context: Context) {
    private val preferences = context.getSharedPreferences("codexlink_wrapped_secrets", Context.MODE_PRIVATE)
    private val alias = "codexlink.master.v1"

    @Synchronized
    fun getOrCreate(name: String, size: Int = 32): ByteArray {
        preferences.getString(name, null)?.let(::unwrap)?.let { return it }
        return ByteArray(size).also(SecureRandom()::nextBytes).also { secret ->
            preferences.edit().putString(name, wrap(secret)).commit()
        }
    }

    @Synchronized
    fun put(name: String, value: ByteArray) {
        preferences.edit().putString(name, wrap(value)).commit()
    }

    @Synchronized
    fun get(name: String): ByteArray? = preferences.getString(name, null)?.let(::unwrap)

    private fun masterKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build()
            )
            generateKey()
        }
    }

    private fun wrap(value: ByteArray): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, masterKey())
        val encrypted = cipher.doFinal(value)
        return listOf(cipher.iv, encrypted).joinToString(".") { Base64.encodeToString(it, Base64.NO_WRAP) }
    }

    private fun unwrap(value: String): ByteArray? = runCatching {
        val (iv, encrypted) = value.split(".", limit = 2).map { Base64.decode(it, Base64.NO_WRAP) }
        Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.DECRYPT_MODE, masterKey(), GCMParameterSpec(128, iv))
            doFinal(encrypted)
        }
    }.getOrNull()
}
