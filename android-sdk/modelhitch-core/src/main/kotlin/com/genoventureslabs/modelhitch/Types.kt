package com.genoventureslabs.modelhitch

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

sealed interface MessageContent {
    data class Text(val value: String) : MessageContent
    data class Parts(val value: List<ContentPart>) : MessageContent
}

sealed interface ContentPart {
    data class Text(val text: String) : ContentPart
    data class Image(val imageUrl: String) : ContentPart
    data class ImageData(val data: String, val mimeType: String) : ContentPart
}

sealed interface ModelMessage {
    data class System(val content: MessageContent, val name: String? = null) : ModelMessage
    data class User(val content: MessageContent, val name: String? = null) : ModelMessage
    data class Assistant(
        val content: MessageContent,
        val toolCalls: List<ToolCall>? = null,
    ) : ModelMessage
    data class Tool(val content: String, val toolCallId: String) : ModelMessage
}

data class ToolDefinition(
    val name: String,
    val description: String? = null,
    val parameters: JsonObject? = null,
)

data class ToolCall(
    val id: String,
    val name: String,
    val arguments: JsonObject,
    val thoughtSignature: String? = null,
)

sealed interface ToolChoice {
    data object Auto : ToolChoice
    data object None : ToolChoice
    data object Required : ToolChoice
    data class Function(val name: String) : ToolChoice
}

sealed interface ResponseFormat {
    data object Text : ResponseFormat
    data object Json : ResponseFormat
    data class JsonSchema(
        val schema: JsonObject,
        val name: String = "response",
        val strict: Boolean = false,
    ) : ResponseFormat
}

data class ChatParams(
    val model: String,
    val messages: List<ModelMessage>,
    val tools: List<ToolDefinition>? = null,
    val temperature: Double? = null,
    val maxTokens: Int? = null,
    val stop: List<String>? = null,
    val toolChoice: ToolChoice? = null,
    val responseFormat: ResponseFormat? = null,
    val previousResponseId: String? = null,
)

data class ChatRequest(
    val messages: List<ModelMessage>,
    val provider: String? = null,
    val model: String? = null,
    val apiKey: String? = null,
    val baseUrl: String? = null,
    val tools: List<ToolDefinition>? = null,
    val temperature: Double? = null,
    val maxTokens: Int? = null,
    val stop: List<String>? = null,
    val toolChoice: ToolChoice? = null,
    val responseFormat: ResponseFormat? = null,
    val previousResponseId: String? = null,
)

data class Usage(
    val inputTokens: Int? = null,
    val outputTokens: Int? = null,
    val totalTokens: Int? = null,
)

data class ChatResult(
    val message: ModelMessage.Assistant,
    val finishReason: String,
    val usage: Usage? = null,
    val raw: JsonElement? = null,
)

sealed interface StreamChunk {
    data class TextDelta(val text: String) : StreamChunk
    data class ToolCallStart(
        val id: String,
        val name: String,
        val thoughtSignature: String? = null,
    ) : StreamChunk
    data class ToolCallArgumentsDelta(val id: String, val argumentsDelta: String) : StreamChunk
    data class ToolCallEnd(val id: String) : StreamChunk
    data class Finish(
        val finishReason: String,
        val usage: Usage? = null,
        val responseId: String? = null,
    ) : StreamChunk
}

data class Capabilities(
    val streaming: Boolean,
    val toolCalling: Boolean,
    val vision: Boolean,
    val embeddings: Boolean,
    val maxContextTokens: Int? = null,
)

data class ProviderCredentials(
    val apiKey: String? = null,
    val baseUrl: String? = null,
)

data class ModelInfo(
    val id: String,
    val name: String? = null,
    val contextLength: Int? = null,
)

fun text(value: String): MessageContent = MessageContent.Text(value)