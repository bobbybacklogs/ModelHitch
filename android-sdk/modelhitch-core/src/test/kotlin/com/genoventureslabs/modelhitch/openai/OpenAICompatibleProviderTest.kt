package com.genoventureslabs.modelhitch.openai

import com.genoventureslabs.modelhitch.ChatRequest
import com.genoventureslabs.modelhitch.MemoryKeyStore
import com.genoventureslabs.modelhitch.MessageContent
import com.genoventureslabs.modelhitch.ModelHitch
import com.genoventureslabs.modelhitch.ModelHitchErrorCode
import com.genoventureslabs.modelhitch.ModelHitchException
import com.genoventureslabs.modelhitch.ModelMessage
import com.genoventureslabs.modelhitch.StreamChunk
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class OpenAICompatibleProviderTest {
    private val server = MockWebServer()

    @AfterTest
    fun closeServer() {
        server.close()
    }

    @Test
    fun `chat resolves stored credentials and normalizes response`() = runTest {
        server.enqueue(MockResponse().setBody(
            """{"choices":[{"message":{"role":"assistant","content":"Hello Android"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}""",
        ))
        val keyStore = MemoryKeyStore().apply { set("test", "stored-key") }
        val hitch = ModelHitch(listOf(provider()), keyStore)

        val result = hitch.chat(ChatRequest(messages = listOf(ModelMessage.User(MessageContent.Text("Hello")))))

        assertEquals("Hello Android", (result.message.content as MessageContent.Text).value)
        assertEquals(5, result.usage?.totalTokens)
        val request = server.takeRequest()
        assertEquals("Bearer stored-key", request.getHeader("Authorization"))
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals("test-model", body["model"]?.jsonPrimitive?.content)
    }

    @Test
    fun `stream emits normalized text and finish chunks`() = runTest {
        server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody(
            """
            : keep-alive

            data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}

            data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}

            data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":7}}

            data: [DONE]

            """.trimIndent() + "\n\n",
        ))
        val hitch = ModelHitch(listOf(provider(requiresKey = false)))

        val chunks = hitch.stream(
            ChatRequest(messages = listOf(ModelMessage.User(MessageContent.Text("Stream")))),
        ).toList()

        assertEquals(listOf("Hel", "lo"), chunks.filterIsInstance<StreamChunk.TextDelta>().map { it.text })
        val finish = assertIs<StreamChunk.Finish>(chunks.last())
        assertEquals("stop", finish.finishReason)
        assertEquals(7, finish.usage?.totalTokens)
        assertTrue(server.takeRequest().body.readUtf8().contains("\"stream\":true"))
    }

    @Test
    fun `stream retains tool call id across fragmented argument frames`() = runTest {
        server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody(
            """
            data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_real","function":{"name":"weather","arguments":""}}]},"finish_reason":null}]}

            data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"city\":"}}]},"finish_reason":null}]}

            data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"Tokyo\"}"}}]},"finish_reason":null}]}

            data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}

            data: [DONE]

            """.trimIndent() + "\n\n",
        ))
        val hitch = ModelHitch(listOf(provider(requiresKey = false)))

        val chunks = hitch.stream(
            ChatRequest(messages = listOf(ModelMessage.User(MessageContent.Text("Weather")))),
        ).toList()

        assertEquals("call_real", assertIs<StreamChunk.ToolCallStart>(chunks[0]).id)
        val arguments = chunks.filterIsInstance<StreamChunk.ToolCallArgumentsDelta>()
        assertTrue(arguments.all { it.id == "call_real" })
        assertEquals("{\"city\":\"Tokyo\"}", arguments.joinToString("") { it.argumentsDelta })
        assertEquals("call_real", assertIs<StreamChunk.ToolCallEnd>(chunks[chunks.lastIndex - 1]).id)
        assertEquals("tool-calls", assertIs<StreamChunk.Finish>(chunks.last()).finishReason)
    }

    @Test
    fun `stream merges standard usage-only frame into one finish event`() = runTest {
        server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody(
            """
            data: {"choices":[{"delta":{"content":"Done"},"finish_reason":null}]}

            data: {"choices":[{"delta":{},"finish_reason":"stop"}]}

            data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}

            data: [DONE]

            """.trimIndent() + "\n\n",
        ))
        val hitch = ModelHitch(listOf(provider(requiresKey = false)))

        val chunks = hitch.stream(
            ChatRequest(messages = listOf(ModelMessage.User(MessageContent.Text("Usage")))),
        ).toList()

        val finishes = chunks.filterIsInstance<StreamChunk.Finish>()
        assertEquals(1, finishes.size)
        assertEquals(6, finishes.single().usage?.totalTokens)
    }

    @Test
    fun `stream turns HTTP 200 error frame into typed provider failure`() = runTest {
        server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody(
            """data: {"error":{"message":"upstream unavailable"}}""" + "\n\n",
        ))
        val hitch = ModelHitch(listOf(provider(requiresKey = false)))

        val error = assertFailsWith<ModelHitchException> {
            hitch.stream(
                ChatRequest(messages = listOf(ModelMessage.User(MessageContent.Text("Fail")))),
            ).toList()
        }

        assertEquals(ModelHitchErrorCode.PROVIDER_ERROR, error.code)
        assertTrue(error.message.orEmpty().contains("upstream unavailable"))
    }

    @Test
    fun `rate limit parses Retry-After seconds`() = runTest {
        server.enqueue(MockResponse().setResponseCode(429).setHeader("Retry-After", "3"))
        val hitch = ModelHitch(listOf(provider(requiresKey = false)))

        val error = assertFailsWith<ModelHitchException> {
            hitch.chat(ChatRequest(messages = listOf(ModelMessage.User(MessageContent.Text("Wait")))))
        }

        assertEquals(ModelHitchErrorCode.RATE_LIMITED, error.code)
        assertEquals(3_000, error.retryAfterMillis)
    }

    @Test
    fun `rate limit parses RFC 1123 Retry-After on legacy Android compatible APIs`() = runTest {
        val retryAt = System.currentTimeMillis() + 30_000
        val header = SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss 'GMT'", Locale.US).run {
            timeZone = TimeZone.getTimeZone("GMT")
            format(Date(retryAt))
        }
        server.enqueue(MockResponse().setResponseCode(429).setHeader("Retry-After", header))
        val hitch = ModelHitch(listOf(provider(requiresKey = false)))

        val error = assertFailsWith<ModelHitchException> {
            hitch.chat(ChatRequest(messages = listOf(ModelMessage.User(MessageContent.Text("Wait")))))
        }

        assertEquals(ModelHitchErrorCode.RATE_LIMITED, error.code)
        assertTrue(assertNotNull(error.retryAfterMillis) in 25_000L..30_000L)
    }

    private fun provider(requiresKey: Boolean = true) = OpenAICompatibleProvider(
        OpenAICompatibleConfig(
            id = "test",
            name = "Test",
            defaultModel = "test-model",
            baseUrl = server.url("v1").toString(),
            requiresKey = requiresKey,
        ),
    )
}