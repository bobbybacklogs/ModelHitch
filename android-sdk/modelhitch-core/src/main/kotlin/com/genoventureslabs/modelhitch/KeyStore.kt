package com.genoventureslabs.modelhitch

interface KeyStore {
    suspend fun get(providerId: String): String?
    suspend fun set(providerId: String, apiKey: String)
    suspend fun delete(providerId: String)
}

class MemoryKeyStore : KeyStore {
    private val keys = mutableMapOf<String, String>()

    override suspend fun get(providerId: String): String? = synchronized(keys) { keys[providerId] }

    override suspend fun set(providerId: String, apiKey: String) {
        synchronized(keys) { keys[providerId] = apiKey }
    }

    override suspend fun delete(providerId: String) {
        synchronized(keys) { keys.remove(providerId) }
    }
}