package com.genoventureslabs.modelhitch.android

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.genoventureslabs.modelhitch.KeyStore
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.security.KeyStore as JavaKeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

class CredentialStorageException(
    val providerId: String,
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause)

class AndroidKeyStoreCredentialStore(
    context: Context,
    preferencesName: String = DEFAULT_PREFERENCES_NAME,
    private val keyAlias: String = DEFAULT_KEY_ALIAS,
) : KeyStore {
    private val preferences: SharedPreferences = context.applicationContext.getSharedPreferences(
        preferencesName,
        Context.MODE_PRIVATE,
    )
    private val mutex = Mutex()

    override suspend fun get(providerId: String): String? = withContext(Dispatchers.IO) {
        mutex.withLock {
            val encoded = preferences.getString(preferenceKey(providerId), null) ?: return@withLock null
            try {
                decrypt(providerId, Base64.decode(encoded, Base64.NO_WRAP))
            } catch (error: Exception) {
                throw CredentialStorageException(
                    providerId = providerId,
                    message = "Stored credential for provider \"$providerId\" could not be decrypted.",
                    cause = error,
                )
            }
        }
    }

    override suspend fun set(providerId: String, apiKey: String) = withContext(Dispatchers.IO) {
        require(providerId.isNotBlank()) { "providerId must not be blank." }
        mutex.withLock {
            try {
                val encoded = Base64.encodeToString(encrypt(providerId, apiKey), Base64.NO_WRAP)
                if (!preferences.edit().putString(preferenceKey(providerId), encoded).commit()) {
                    throw IllegalStateException("SharedPreferences commit failed.")
                }
            } catch (error: Exception) {
                if (error is CredentialStorageException) throw error
                throw CredentialStorageException(
                    providerId = providerId,
                    message = "Credential for provider \"$providerId\" could not be stored.",
                    cause = error,
                )
            }
        }
    }

    override suspend fun delete(providerId: String) = withContext(Dispatchers.IO) {
        mutex.withLock {
            if (!preferences.edit().remove(preferenceKey(providerId)).commit()) {
                throw CredentialStorageException(
                    providerId = providerId,
                    message = "Credential for provider \"$providerId\" could not be deleted.",
                )
            }
        }
    }

    private fun encrypt(providerId: String, apiKey: String): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateSecretKey())
        cipher.updateAAD(associatedData(providerId))
        val ciphertext = cipher.doFinal(apiKey.toByteArray(StandardCharsets.UTF_8))
        return ByteBuffer.allocate(2 + cipher.iv.size + ciphertext.size)
            .put(FORMAT_VERSION)
            .put(cipher.iv.size.toByte())
            .put(cipher.iv)
            .put(ciphertext)
            .array()
    }

    private fun decrypt(providerId: String, envelope: ByteArray): String {
        val buffer = ByteBuffer.wrap(envelope)
        val version = buffer.get()
        require(version == FORMAT_VERSION) { "Unsupported credential format version: $version" }
        val ivLength = buffer.get().toInt() and 0xff
        require(ivLength in 12..16 && buffer.remaining() > ivLength) { "Invalid credential envelope." }
        val iv = ByteArray(ivLength).also(buffer::get)
        val ciphertext = ByteArray(buffer.remaining()).also(buffer::get)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateSecretKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
        cipher.updateAAD(associatedData(providerId))
        return String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8)
    }

    private fun getOrCreateSecretKey(): SecretKey {
        val keyStore = JavaKeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }
        (keyStore.getKey(keyAlias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE).run {
            init(
                KeyGenParameterSpec.Builder(
                    keyAlias,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
            generateKey()
        }
    }

    private fun associatedData(providerId: String): ByteArray =
        "modelhitch:$FORMAT_VERSION:$providerId".toByteArray(StandardCharsets.UTF_8)

    private fun preferenceKey(providerId: String): String = "credential:$providerId"

    companion object {
        const val DEFAULT_PREFERENCES_NAME = "modelhitch_credentials_no_backup"
        const val DEFAULT_KEY_ALIAS = "modelhitch.credentials.v1"
        private const val ANDROID_KEY_STORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val GCM_TAG_BITS = 128
        private const val FORMAT_VERSION: Byte = 1
    }
}