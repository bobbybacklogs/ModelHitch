package com.genoventureslabs.modelhitch.openai

import com.genoventureslabs.modelhitch.Capabilities
import com.genoventureslabs.modelhitch.ChatParams
import com.genoventureslabs.modelhitch.ChatResult
import com.genoventureslabs.modelhitch.ContentPart
import com.genoventureslabs.modelhitch.MessageContent
import com.genoventureslabs.modelhitch.ModelHitchErrorCode
import com.genoventureslabs.modelhitch.ModelHitchException
import com.genoventureslabs.modelhitch.ModelInfo
import com.genoventureslabs.modelhitch.ModelMessage
import com.genoventureslabs.modelhitch.Provider
import com.genoventureslabs.modelhitch.ProviderCredentials
import com.genoventureslabs.modelhitch.ResponseFormat
import com.genoventureslabs.modelhitch.StreamChunk
import com.genoventureslabs.modelhitch.ToolCall
import com.genoventureslabs.modelhitch.ToolChoice
import com.genoventureslabs.modelhitch.Usage
import com.genoventureslabs.modelhitch.internal.SseParser
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.Buffer
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

data class OpenAICompatibleConfig(
    val id: String,
    val name: String,
    val defaultModel: String,
    val baseUrl: String,
    val requiresKey: Boolean = true,
    val headers: Map<String, String> = emptyMap(),
    val capabilities: Capabilities = Capabilities(
        streaming = true,
        toolCalling = true,
        vision = true,
        embeddings = false,
    ),
)

class OpenAICompatibleProvider(
    private val config: OpenAICompatibleConfig,
    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build(),
    private val json: Json = Json { ignoreUnknownKeys = true },
) : Provider {
    override val id = config.id
    override val name = config.name
    override val defaultModel = config.defaultModel
    override val capabilities = config.capabilities

    override suspend fun chat(params: ChatParams, credentials: ProviderCredentials): ChatResult {
        val response = execute(buildRequest(params, credentials, stream = false))
        response.use {
            val body = it.body.string()
            if (!it.isSuccessful) throw mapHttpError(it, body)
            return parseChatResult(body)
        }
    }

    override fun stream(params: ChatParams, credentials: ProviderCredentials): Flow<StreamChunk> = flow {
        val call = httpClient.newCall(buildRequest(params, credentials, stream = true))
        val cancellationHandle = currentCoroutineContext()[Job]?.invokeOnCompletion { call.cancel() }
        try {
            val response = execute(call)
            response.use {
                if (!it.isSuccessful) throw mapHttpError(it, it.body.string())
                val source = it.body.source()
                val parser = SseParser()
                val buffer = Buffer()
                val state = StreamState()
                while (!source.exhausted()) {
                    currentCoroutineContext().ensureActive()
                    val read = source.read(buffer, 8_192)
                    if (read < 0) break
                    for (payload in parser.accept(buffer.readUtf8())) {
                        for (chunk in parseStreamPayload(payload, state)) emit(chunk)
                    }
                }
                for (payload in parser.finish()) {
                    for (chunk in parseStreamPayload(payload, state)) emit(chunk)
                }
                state.finish(force = true)?.let { emit(it) }
            }
        } finally {
            cancellationHandle?.dispose()
            call.cancel()
        }
    }.flowOn(Dispatchers.IO)

    override suspend fun listModels(credentials: ProviderCredentials): List<ModelInfo> {
        val response = execute(buildGetRequest("models", credentials))
        response.use {
            val body = it.body.string()
            if (!it.isSuccessful) throw mapHttpError(it, body)
            val root = json.parseToJsonElement(body).jsonObject
            return root["data"]?.jsonArray.orEmpty().map { model ->
                val value = model.jsonObject
                ModelInfo(
                    id = value.string("id") ?: "",
                    name = value.string("name"),
                    contextLength = value["context_length"]?.jsonPrimitive?.intOrNull,
                )
            }.filter { it.id.isNotEmpty() }
        }
    }

    private fun buildRequest(params: ChatParams, credentials: ProviderCredentials, stream: Boolean): Request {
        val body = buildBody(params, stream).toString().toRequestBody(JSON_MEDIA_TYPE)
        return requestBuilder("chat/completions", credentials)
            .post(body)
            .build()
    }

    private fun buildGetRequest(path: String, credentials: ProviderCredentials): Request =
        requestBuilder(path, credentials).get().build()

    private fun requestBuilder(path: String, credentials: ProviderCredentials): Request.Builder {
        val apiKey = credentials.apiKey
        if (config.requiresKey && apiKey.isNullOrBlank()) {
            throw ModelHitchException(
                code = ModelHitchErrorCode.MISSING_API_KEY,
                message = "Provider \"$id\" requires an API key.",
                providerId = id,
            )
        }
        val baseUrl = (credentials.baseUrl ?: config.baseUrl).trimEnd('/')
        return Request.Builder()
            .url("$baseUrl/$path")
            .header("Content-Type", "application/json")
            .apply {
                config.headers.forEach(::header)
                if (!apiKey.isNullOrBlank()) header("Authorization", "Bearer $apiKey")
            }
    }

    private fun buildBody(params: ChatParams, stream: Boolean): JsonObject = buildJsonObject {
        put("model", params.model)
        put("messages", buildJsonArray { params.messages.forEach { add(messageToJson(it)) } })
        params.tools?.takeIf(List<*>::isNotEmpty)?.let { tools ->
            put("tools", buildJsonArray {
                tools.forEach { tool ->
                    add(buildJsonObject {
                        put("type", "function")
                        put("function", buildJsonObject {
                            put("name", tool.name)
                            tool.description?.let { put("description", it) }
                            tool.parameters?.let { put("parameters", it) }
                        })
                    })
                }
            })
        }
        params.temperature?.let { put("temperature", it) }
        params.maxTokens?.let { put("max_tokens", it) }
        params.stop?.let { put("stop", JsonArray(it.map(::JsonPrimitive))) }
        params.toolChoice?.let { put("tool_choice", toolChoiceToJson(it)) }
        params.responseFormat?.let { put("response_format", responseFormatToJson(it)) }
        if (stream) {
            put("stream", true)
            put("stream_options", buildJsonObject { put("include_usage", true) })
        }
    }

    private fun messageToJson(message: ModelMessage): JsonObject = buildJsonObject {
        when (message) {
            is ModelMessage.System -> {
                put("role", "system")
                put("content", contentToJson(message.content))
                message.name?.let { put("name", it) }
            }
            is ModelMessage.User -> {
                put("role", "user")
                put("content", contentToJson(message.content))
                message.name?.let { put("name", it) }
            }
            is ModelMessage.Assistant -> {
                put("role", "assistant")
                put("content", contentToJson(message.content))
                message.toolCalls?.let { calls ->
                    put("tool_calls", buildJsonArray {
                        calls.forEach { call ->
                            add(buildJsonObject {
                                put("id", call.id)
                                put("type", "function")
                                put("function", buildJsonObject {
                                    put("name", call.name)
                                    put("arguments", call.arguments.toString())
                                })
                            })
                        }
                    })
                }
            }
            is ModelMessage.Tool -> {
                put("role", "tool")
                put("content", message.content)
                put("tool_call_id", message.toolCallId)
            }
        }
    }

    private fun contentToJson(content: MessageContent): JsonElement = when (content) {
        is MessageContent.Text -> JsonPrimitive(content.value)
        is MessageContent.Parts -> buildJsonArray {
            content.value.forEach { part ->
                add(buildJsonObject {
                    when (part) {
                        is ContentPart.Text -> {
                            put("type", "text")
                            put("text", part.text)
                        }
                        is ContentPart.Image -> {
                            put("type", "image_url")
                            put("image_url", buildJsonObject { put("url", part.imageUrl) })
                        }
                        is ContentPart.ImageData -> {
                            put("type", "image_url")
                            put("image_url", buildJsonObject {
                                put("url", "data:${part.mimeType};base64,${part.data}")
                            })
                        }
                    }
                })
            }
        }
    }

    private fun toolChoiceToJson(choice: ToolChoice): JsonElement = when (choice) {
        ToolChoice.Auto -> JsonPrimitive("auto")
        ToolChoice.None -> JsonPrimitive("none")
        ToolChoice.Required -> JsonPrimitive("required")
        is ToolChoice.Function -> buildJsonObject {
            put("type", "function")
            put("function", buildJsonObject { put("name", choice.name) })
        }
    }

    private fun responseFormatToJson(format: ResponseFormat): JsonElement = when (format) {
        ResponseFormat.Text -> buildJsonObject { put("type", "text") }
        ResponseFormat.Json -> buildJsonObject { put("type", "json_object") }
        is ResponseFormat.JsonSchema -> buildJsonObject {
            put("type", "json_schema")
            put("json_schema", buildJsonObject {
                put("name", format.name)
                put("strict", format.strict)
                put("schema", format.schema)
            })
        }
    }

    private fun parseChatResult(body: String): ChatResult {
        val root = parseObject(body)
        val choice = root["choices"]?.jsonArray?.firstOrNull()?.jsonObject
            ?: throw providerError("returned no message")
        val message = choice["message"]?.jsonObject ?: throw providerError("returned no message")
        val toolCalls = message["tool_calls"]?.jsonArray?.mapIndexed { index, element ->
            val call = element.jsonObject
            val function = call["function"]?.jsonObject ?: JsonObject(emptyMap())
            ToolCall(
                id = call.string("id") ?: "call_$index",
                name = function.string("name") ?: "unknown",
                arguments = parseArguments(function.string("arguments")),
            )
        }
        return ChatResult(
            message = ModelMessage.Assistant(
                content = MessageContent.Text(message.string("content") ?: ""),
                toolCalls = toolCalls?.takeIf(List<*>::isNotEmpty),
            ),
            finishReason = mapFinishReason(choice.string("finish_reason")),
            usage = parseUsage(root["usage"]),
            raw = root,
        )
    }

    private fun parseStreamPayload(payload: String, state: StreamState): List<StreamChunk> {
        val root = runCatching { parseObject(payload) }.getOrNull() ?: return emptyList()
        root["error"]?.let { errorElement ->
            val error = runCatching { errorElement.jsonObject }.getOrNull()
            val message = error?.string("message") ?: "stream failed"
            throw ModelHitchException(
                code = ModelHitchErrorCode.PROVIDER_ERROR,
                message = "Provider \"$id\" stream failed: $message",
                providerId = id,
            )
        }
        parseUsage(root["usage"])?.let { state.usage = it }
        val choice = root["choices"]?.jsonArray?.firstOrNull()?.jsonObject
            ?: return listOfNotNull(state.finish(force = false))
        val delta = choice["delta"]?.jsonObject ?: JsonObject(emptyMap())
        val chunks = mutableListOf<StreamChunk>()
        delta.string("content")?.takeIf(String::isNotEmpty)?.let { chunks += StreamChunk.TextDelta(it) }
        delta["tool_calls"]?.jsonArray?.forEach { element ->
            val tool = element.jsonObject
            val index = tool["index"]?.jsonPrimitive?.intOrNull ?: 0
            val function = tool["function"]?.jsonObject ?: JsonObject(emptyMap())
            val callId = tool.string("id") ?: state.toolCalls[index] ?: "call_$index"
            function.string("name")?.let {
                state.toolCalls[index] = callId
                chunks += StreamChunk.ToolCallStart(callId, it)
            }
            function.string("arguments")?.takeIf(String::isNotEmpty)?.let {
                chunks += StreamChunk.ToolCallArgumentsDelta(callId, it)
            }
        }
        choice.string("finish_reason")?.let {
            if (it == "tool_calls") {
                state.toolCalls.toSortedMap().values.forEach { callId -> chunks += StreamChunk.ToolCallEnd(callId) }
            }
            state.finishReason = mapFinishReason(it)
        }
        state.finish(force = false)?.let { chunks += it }
        return chunks
    }

    private suspend fun execute(request: Request): Response {
        val call = httpClient.newCall(request)
        return execute(call)
    }

    private suspend fun execute(call: Call): Response {
        return try {
            call.await()
        } catch (error: IOException) {
            throw ModelHitchException(
                code = ModelHitchErrorCode.NETWORK_ERROR,
                message = "Request to provider \"$id\" failed: ${error.message}",
                providerId = id,
                cause = error,
            )
        }
    }

    private fun mapHttpError(response: Response, body: String): ModelHitchException {
        val code = when (response.code) {
            401, 403 -> ModelHitchErrorCode.INVALID_API_KEY
            404 -> ModelHitchErrorCode.MODEL_NOT_FOUND
            429 -> ModelHitchErrorCode.RATE_LIMITED
            in 500..599 -> ModelHitchErrorCode.PROVIDER_ERROR
            else -> ModelHitchErrorCode.BAD_REQUEST
        }
        val retryAfter = parseRetryAfter(response.header("Retry-After"))
        val detail = body.take(300).takeIf(String::isNotBlank)?.let { " ($it)" }.orEmpty()
        return ModelHitchException(
            code = code,
            message = "Provider \"$id\" returned HTTP ${response.code}.$detail",
            status = response.code,
            providerId = id,
            retryAfterMillis = retryAfter,
        )
    }

    private fun providerError(detail: String) = ModelHitchException(
        code = ModelHitchErrorCode.PROVIDER_ERROR,
        message = "Provider \"$id\" $detail.",
        providerId = id,
    )

    private fun parseObject(value: String): JsonObject = json.parseToJsonElement(value).jsonObject

    private fun parseArguments(value: String?): JsonObject = runCatching {
        value?.let(json::parseToJsonElement)?.jsonObject
    }.getOrNull() ?: JsonObject(emptyMap())

    private fun parseUsage(value: JsonElement?): Usage? {
        if (value == null || value is JsonNull) return null
        val usage = value.jsonObject
        return Usage(
            inputTokens = usage["prompt_tokens"]?.jsonPrimitive?.intOrNull,
            outputTokens = usage["completion_tokens"]?.jsonPrimitive?.intOrNull,
            totalTokens = usage["total_tokens"]?.jsonPrimitive?.intOrNull,
        )
    }

    private fun mapFinishReason(value: String?): String = when (value) {
        null, "stop" -> "stop"
        "tool_calls" -> "tool-calls"
        "content_filter" -> "content-filter"
        else -> value
    }

    private fun JsonObject.string(key: String): String? = this[key]?.jsonPrimitive?.contentOrNull

    private fun parseRetryAfter(value: String?): Long? {
        if (value == null) return null
        value.toLongOrNull()?.let { return it.coerceAtLeast(0) * 1_000 }
        return runCatching {
            val format = SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss 'GMT'", Locale.US).apply {
                isLenient = false
                timeZone = TimeZone.getTimeZone("GMT")
            }
            (requireNotNull(format.parse(value)).time - System.currentTimeMillis()).coerceAtLeast(0)
        }.getOrNull()
    }

    private class StreamState {
        val toolCalls = mutableMapOf<Int, String>()
        var finishReason: String? = null
        var usage: Usage? = null
        private var finishEmitted = false

        fun finish(force: Boolean): StreamChunk.Finish? {
            val reason = finishReason ?: return null
            if (finishEmitted || (!force && usage == null)) return null
            finishEmitted = true
            return StreamChunk.Finish(reason, usage)
        }
    }

    private suspend fun Call.await(): Response = suspendCancellableCoroutine { continuation ->
        continuation.invokeOnCancellation { cancel() }
        enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (continuation.isActive) continuation.resumeWithException(e)
            }

            override fun onResponse(call: Call, response: Response) {
                if (continuation.isActive) continuation.resume(response) else response.close()
            }
        })
    }

    private companion object {
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}