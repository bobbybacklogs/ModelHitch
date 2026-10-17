import Foundation

/// A conversation participant role.
public enum Role: String, Sendable, Codable {
    case system
    case user
    case assistant
    case tool
}

/// A content part for multimodal messages.
public enum ContentPart: Sendable, Equatable {
    case text(String)
    case imageURL(String)
    case imageData(data: String, mimeType: String)
}

/// Message content: plain text, or a list of parts for multimodal models.
public enum MessageContent: Sendable, Equatable {
    case text(String)
    case parts([ContentPart])
}

/// A tool the model may call. `parameters` is a JSON Schema object.
public struct ToolDefinition: Sendable, Equatable {
    public var name: String
    public var description: String?
    public var parameters: JSONValue?

    public init(name: String, description: String? = nil, parameters: JSONValue? = nil) {
        self.name = name
        self.description = description
        self.parameters = parameters
    }
}

/// A tool invocation emitted by the model.
public struct ToolCall: Sendable, Equatable {
    public var id: String
    public var name: String
    public var arguments: JSONValue
    /// Provider-specific token the model requires when the client re-sends the
    /// tool call on the next turn (for example Gemini's `thoughtSignature`).
    public var thoughtSignature: String?

    public init(
        id: String, name: String, arguments: JSONValue = .object([:]),
        thoughtSignature: String? = nil
    ) {
        self.id = id
        self.name = name
        self.arguments = arguments
        self.thoughtSignature = thoughtSignature
    }
}

/// How the model should decide which tool to call.
public enum ToolChoice: Sendable, Equatable {
    case auto
    case none
    case required
    case function(name: String)
}

/// Structured output request.
public enum ResponseFormat: Sendable, Equatable {
    case text
    case jsonObject
    case jsonSchema(name: String?, strict: Bool?, schema: JSONValue)
}

/// A single message in a conversation.
public struct ModelMessage: Sendable, Equatable {
    public var role: Role
    public var content: MessageContent
    public var name: String?
    public var toolCalls: [ToolCall]?
    public var toolCallId: String?
    /// Chain-of-thought text emitted by reasoning models. Thinking-mode APIs
    /// require this to be passed back verbatim on the assistant message.
    public var reasoningContent: String?

    public init(
        role: Role,
        content: MessageContent,
        name: String? = nil,
        toolCalls: [ToolCall]? = nil,
        toolCallId: String? = nil,
        reasoningContent: String? = nil
    ) {
        self.role = role
        self.content = content
        self.name = name
        self.toolCalls = toolCalls
        self.toolCallId = toolCallId
        self.reasoningContent = reasoningContent
    }

    public static func system(_ text: String, name: String? = nil) -> ModelMessage {
        ModelMessage(role: .system, content: .text(text), name: name)
    }

    public static func user(_ text: String, name: String? = nil) -> ModelMessage {
        ModelMessage(role: .user, content: .text(text), name: name)
    }

    public static func assistant(
        _ text: String,
        toolCalls: [ToolCall]? = nil,
        reasoningContent: String? = nil
    ) -> ModelMessage {
        ModelMessage(
            role: .assistant,
            content: .text(text),
            toolCalls: toolCalls,
            reasoningContent: reasoningContent
        )
    }

    public static func tool(_ text: String, toolCallId: String) -> ModelMessage {
        ModelMessage(role: .tool, content: .text(text), toolCallId: toolCallId)
    }

    /// Convenience: the message's text, joining text parts when multimodal.
    public var text: String {
        switch content {
        case .text(let value):
            return value
        case .parts(let parts):
            return parts.compactMap { part in
                if case .text(let value) = part { return value }
                return nil
            }.joined()
        }
    }
}

/// Normalized, provider-agnostic parameters for a chat request.
public struct ChatParams: Sendable {
    public var model: String
    public var messages: [ModelMessage]
    public var tools: [ToolDefinition]?
    public var temperature: Double?
    public var maxTokens: Int?
    public var stop: [String]?
    public var toolChoice: ToolChoice?
    public var responseFormat: ResponseFormat?
    /// Responses-API continuation: id of the previous response.
    public var previousResponseId: String?
    /// Optional session id forwarded as `x-session-id` for caching/routing.
    public var sessionId: String?

    public init(
        model: String,
        messages: [ModelMessage],
        tools: [ToolDefinition]? = nil,
        temperature: Double? = nil,
        maxTokens: Int? = nil,
        stop: [String]? = nil,
        toolChoice: ToolChoice? = nil,
        responseFormat: ResponseFormat? = nil,
        previousResponseId: String? = nil,
        sessionId: String? = nil
    ) {
        self.model = model
        self.messages = messages
        self.tools = tools
        self.temperature = temperature
        self.maxTokens = maxTokens
        self.stop = stop
        self.toolChoice = toolChoice
        self.responseFormat = responseFormat
        self.previousResponseId = previousResponseId
        self.sessionId = sessionId
    }
}

/// Token usage, normalized.
public struct Usage: Sendable, Equatable {
    public var inputTokens: Int?
    public var outputTokens: Int?
    public var totalTokens: Int?

    public init(inputTokens: Int? = nil, outputTokens: Int? = nil, totalTokens: Int? = nil) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.totalTokens = totalTokens
    }
}

/// A complete (non-streaming) chat result.
public struct ChatResult: Sendable {
    public var message: ModelMessage
    public var finishReason: String
    public var usage: Usage?
    public var responseId: String?
    /// Provider-specific raw payload, when available.
    public var raw: JSONValue?

    public init(
        message: ModelMessage,
        finishReason: String,
        usage: Usage? = nil,
        responseId: String? = nil,
        raw: JSONValue? = nil
    ) {
        self.message = message
        self.finishReason = finishReason
        self.usage = usage
        self.responseId = responseId
        self.raw = raw
    }
}

/// A single normalized streaming event.
public enum StreamChunk: Sendable, Equatable {
    case textDelta(String)
    case reasoningDelta(String)
    case toolCallStart(id: String, name: String, thoughtSignature: String? = nil)
    case toolCallArgsDelta(id: String, argsDelta: String)
    case toolCallEnd(id: String)
    case finish(finishReason: String, usage: Usage? = nil, responseId: String? = nil)
}

/// What a provider can do. Used for capability detection and filtering.
public struct Capabilities: Sendable, Equatable {
    public var streaming: Bool
    public var toolCalling: Bool
    public var vision: Bool
    public var embeddings: Bool
    public var maxContextTokens: Int?

    public init(
        streaming: Bool,
        toolCalling: Bool,
        vision: Bool,
        embeddings: Bool,
        maxContextTokens: Int? = nil
    ) {
        self.streaming = streaming
        self.toolCalling = toolCalling
        self.vision = vision
        self.embeddings = embeddings
        self.maxContextTokens = maxContextTokens
    }
}

/// Per-call credentials resolved by the client (from input or the KeyStore).
public struct ProviderCredentials: Sendable, Equatable {
    public var apiKey: String?
    public var baseUrl: String?

    public init(apiKey: String? = nil, baseUrl: String? = nil) {
        self.apiKey = apiKey
        self.baseUrl = baseUrl
    }
}

/// Metadata about a model available from a provider (from `/models` endpoints).
public struct ModelInfo: Sendable, Equatable {
    public var id: String
    public var name: String?
    public var contextLength: Int?

    public init(id: String, name: String? = nil, contextLength: Int? = nil) {
        self.id = id
        self.name = name
        self.contextLength = contextLength
    }
}

/// A per-call chat request: ``ChatParams`` plus provider/model/credential
/// overrides. Mirrors the TypeScript `ChatInput`.
public struct ChatInput: Sendable {
    public var messages: [ModelMessage]
    /// Provider id, e.g. "openai" or "vercel-ai-gateway".
    public var provider: String?
    /// Model id; defaults to the client's `defaultModel` or the provider default.
    public var model: String?
    /// Explicit credentials for this call (overrides the KeyStore).
    public var apiKey: String?
    public var baseUrl: String?
    public var tools: [ToolDefinition]?
    public var temperature: Double?
    public var maxTokens: Int?
    public var stop: [String]?
    public var toolChoice: ToolChoice?
    public var responseFormat: ResponseFormat?
    public var previousResponseId: String?
    public var sessionId: String?

    public init(
        messages: [ModelMessage],
        provider: String? = nil,
        model: String? = nil,
        apiKey: String? = nil,
        baseUrl: String? = nil,
        tools: [ToolDefinition]? = nil,
        temperature: Double? = nil,
        maxTokens: Int? = nil,
        stop: [String]? = nil,
        toolChoice: ToolChoice? = nil,
        responseFormat: ResponseFormat? = nil,
        previousResponseId: String? = nil,
        sessionId: String? = nil
    ) {
        self.messages = messages
        self.provider = provider
        self.model = model
        self.apiKey = apiKey
        self.baseUrl = baseUrl
        self.tools = tools
        self.temperature = temperature
        self.maxTokens = maxTokens
        self.stop = stop
        self.toolChoice = toolChoice
        self.responseFormat = responseFormat
        self.previousResponseId = previousResponseId
        self.sessionId = sessionId
    }
}
