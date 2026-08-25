package com.genoventureslabs.modelhitch

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class DefaultProvidersTest {
    @Test
    fun `built-in providers have unique ids and usable defaults`() {
        val providers = DefaultProviders.all

        assertEquals(11, providers.size)
        assertEquals(providers.size, providers.map(Provider::id).toSet().size)
        assertTrue(providers.all { it.id.isNotBlank() })
        assertTrue(providers.all { it.name.isNotBlank() })
        assertTrue(providers.all { it.defaultModel.isNotBlank() })
        assertTrue(providers.all { it.capabilities.streaming })
    }

    @Test
    fun `default client exposes every built-in provider`() {
        val hitch = ModelHitch()

        DefaultProviders.all.forEach { provider ->
            assertEquals(provider, hitch.provider(provider.id))
        }
    }
}