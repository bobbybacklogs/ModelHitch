import Foundation

/// One shared adapter for remote and local OpenAI-compatible endpoints.
/// Mirrors the TypeScript `createOpenAICompatibleProvider`.
///
/// Streaming is Server-Sent Events (SSE): each `data:` frame is a JSON
/// chat-completion chunk terminated by `data: [DONE]`.
public final class OpenAICompatibleProvider: Provider, @unchecked Sendable {
    public let id: String
    public let name: String
    public let defaultModel: String
    public let capabilities: Capabilities

    private let baseURL: String
    private let requiresKey: Bool
    private let configuredApiKey: String?
    private let apiKeyEnvVar: String?
    private let session: URLSession

    public init(
        id: String,
        name: String,
        baseURL: String,
        defaultModel: String,
        capabilities: Capabilities,
        requiresKey: Bool = true,
        apiKey: String? = nil,
        apiKeyEnvVar: String? = nil,
        session: URLSession = .shared
    ) {
        self.id = id
        self.name = name
        self.baseURL = baseURL
        self.defaultModel = defaultModel
        self.capabilities = capabilities
        self.requiresKey = requiresKey
        self.configuredApiKey = apiKey
        self.apiKeyEnvVar = apiKeyEnvVar
        self.session = session
    }

    // MARK: - Chat

    public func chat(_ params: ChatParams, credentials: ProviderCredentials) async throws
        -> ChatResult
    {
        do {
            let request = try makeRequest(
                path: "chat/completions", params: params, credentials: credentials, stream: false)
            let (data, response) = try await session.data(for: request)
            try Self.validate(response, providerId: id, body: data)
            return try Self.decodeChatResult(data, providerId: id)
        } catch {
            throw Self.mapError(error, providerId: id)
        }
    }

    // MARK: - Streaming

    public func stream(_ params: ChatParams, credentials: ProviderCredentials)
        -> AsyncThrowingStream<StreamChunk, Error>
    {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let request = try makeRequest(
                        path: "chat/completions", params: params, credentials: credentials,
                        stream: true)
                    let (bytes, response) = try await session.bytes(for: request)
                    try Self.validate(response, providerId: id, body: nil)

                    var toolCallIds = Set<String>()
                    var finishReason = "stop"
                    var usage: Usage?
                    var responseId: String?

                    for try await line in bytes.lines {
                        guard line.hasPrefix("data:") else { continue }
                        let payload = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                        if payload.isEmpty { continue }
                        if payload == "[DONE]" { break }
                        guard let data = payload.data(using: .utf8) else { continue }

                        let root = try JSONDecoder().decode(JSONValue.self, from: data)
                        if responseId == nil { responseId = root["id"]?.stringValue }
                        if usage == nil { usage = Self.decodeUsage(root) }
                        guard let choice = root["choices"]?.arrayValue?.first else { continue }
                        if let reason = choice["finish_reason"]?.stringValue {
                            finishReason = reason
                        }
                        guard let delta = choice["delta"] else { continue }

                        if let reasoning = delta["reasoning_content"]?.stringValue {
                            continuation.yield(.reasoningDelta(reasoning))
                        }
                        if let content = delta["content"]?.stringValue {
                            continuation.yield(.textDelta(content))
                        }
                        for call in delta["tool_calls"]?.arrayValue ?? [] {
                            let callId = call["id"]?.stringValue
                            let index = call["index"]?.intValue.map(String.init) ?? "0"
                            let key = callId ?? index
                            if let callId, toolCallIds.insert(callId).inserted {
                                let name = call["function"]?["name"]?.stringValue ?? "unknown"
                                let signature = call["function"]?["thought_signature"]?.stringValue
                                continuation.yield(
                                    .toolCallStart(
                                        id: callId, name: name, thoughtSignature: signature))
                            }
                            if let arguments = call["function"]?["arguments"]?.stringValue {
                                continuation.yield(
                                    .toolCallArgsDelta(id: key, argsDelta: arguments))
                            }
                        }
                    }

                    for callId in toolCallIds {
                        continuation.yield(.toolCallEnd(id: callId))
                    }
                    continuation.yield(
                        .finish(finishReason: finishReason, usage: usage, responseId: responseId))
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: Self.mapError(error, providerId: id))
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: - Model listing

    public func listModels(credentials: ProviderCredentials) async throws -> [ModelInfo] {
        do {
            guard let url = Self.endpoint(credentials.baseUrl ?? baseURL, "models") else {
                throw ModelHitchError(
                    code: .badRequest, message: "Invalid base URL.", providerId: id)
            }
            var request = URLRequest(url: url)
            request.httpMethod = "GET"
            try applyAuthorization(&request, credentials: credentials)

            let (data, response) = try await session.data(for: request)
            try Self.validate(response, providerId: id, body: data)
            let root = try JSONDecoder().decode(JSONValue.self, from: data)
            return (root["data"]?.arrayValue ?? []).compactMap { item in
                guard let modelId = item["id"]?.stringValue else { return nil }
                return ModelInfo(
                    id: modelId,
                    name: item["name"]?.stringValue,
                    contextLength: item["context_length"]?.intValue
                )
            }
        } catch {
            throw Self.mapError(error, providerId: id)
        }
    }

    // MARK: - Request building

    private func makeRequest(
        path: String,
        params: ChatParams,
        credentials: ProviderCredentials,
        stream: Bool
    ) throws -> URLRequest {
        guard let url = Self.endpoint(credentials.baseUrl ?? baseURL, path) else {
            throw ModelHitchError(code: .badRequest, message: "Invalid base URL.", providerId: id)
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let sessionId = params.sessionId {
            request.setValue(sessionId, forHTTPHeaderField: "x-session-id")
        }
        try applyAuthorization(&request, credentials: credentials)
        request.httpBody = try JSONEncoder().encode(Self.requestBody(params, stream: stream))
        return request
    }

    private func applyAuthorization(_ request: inout URLRequest, credentials: ProviderCredentials)
        throws
    {
        let key = credentials.apiKey ?? configuredApiKey ?? environmentKey
        if requiresKey, key?.isEmpty ?? true {
            throw ModelHitchError(
                code: .missingAPIKey,
                message: "Provider \"\(id)\" requires an API key.",
                providerId: id
            )
        }
        if let key, !key.isEmpty {
            request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        }
    }

    private var environmentKey: String? {
        guard let apiKeyEnvVar, let value = ProcessInfo.processInfo.environment[apiKeyEnvVar],
            !value.isEmpty
        else {
            return nil
        }
        return value
    }

    // MARK: - Encoding

    static func requestBody(_ params: ChatParams, stream: Bool) -> JSONValue {
        var object: [String: JSONValue] = [
            "model": .string(params.model),
            "messages": .array(params.messages.map(encodeMessage)),
        ]
        if let tools = params.tools { object["tools"] = .array(tools.map(encodeTool)) }
        if let temperature = params.temperature { object["temperature"] = .number(temperature) }
        if let maxTokens = params.maxTokens { object["max_tokens"] = .number(Double(maxTokens)) }
        if let stop = params.stop { object["stop"] = .array(stop.map { .string($0) }) }
        if let toolChoice = params.toolChoice {
            object["tool_choice"] = encodeToolChoice(toolChoice)
        }
        if let responseFormat = params.responseFormat,
            let encoded = encodeResponseFormat(responseFormat)
        {
            object["response_format"] = encoded
        }
        if let previousResponseId = params.previousResponseId {
            object["previous_response_id"] = .string(previousResponseId)
        }
        object["stream"] = .bool(stream)
        if stream {
            object["stream_options"] = .object(["include_usage": .bool(true)])
        }
        return .object(object)
    }

    static func encodeMessage(_ message: ModelMessage) -> JSONValue {
        var object: [String: JSONValue] = ["role": .string(message.role.rawValue)]
        switch message.content {
        case .text(let text):
            object["content"] = .string(text)
        case .parts(let parts):
            object["content"] = .array(parts.map(encodePart))
        }
        if let name = message.name { object["name"] = .string(name) }
        if let toolCalls = message.toolCalls, !toolCalls.isEmpty {
            object["tool_calls"] = .array(
                toolCalls.map { call in
                    .object([
                        "id": .string(call.id),
                        "type": .string("function"),
                        "function": .object([
                            "name": .string(call.name),
                            "arguments": .string(call.arguments.jsonString),
                        ]),
                    ])
                })
        }
        if let toolCallId = message.toolCallId { object["tool_call_id"] = .string(toolCallId) }
        if let reasoning = message.reasoningContent {
            object["reasoning_content"] = .string(reasoning)
        }
        return .object(object)
    }

    static func encodePart(_ part: ContentPart) -> JSONValue {
        switch part {
        case .text(let text):
            return .object(["type": .string("text"), "text": .string(text)])
        case .imageURL(let url):
            return .object([
                "type": .string("image_url"), "image_url": .object(["url": .string(url)]),
            ])
        case .imageData(let data, let mimeType):
            return .object([
                "type": .string("image_url"),
                "image_url": .object(["url": .string("data:\(mimeType);base64,\(data)")]),
            ])
        }
    }

    static func encodeTool(_ tool: ToolDefinition) -> JSONValue {
        var function: [String: JSONValue] = ["name": .string(tool.name)]
        if let description = tool.description { function["description"] = .string(description) }
        if let parameters = tool.parameters { function["parameters"] = parameters }
        return .object(["type": .string("function"), "function": .object(function)])
    }

    static func encodeToolChoice(_ choice: ToolChoice) -> JSONValue {
        switch choice {
        case .auto: return .string("auto")
        case .none: return .string("none")
        case .required: return .string("required")
        case .function(let name):
            return .object([
                "type": .string("function"), "function": .object(["name": .string(name)]),
            ])
        }
    }

    static func encodeResponseFormat(_ format: ResponseFormat) -> JSONValue? {
        switch format {
        case .text:
            return nil
        case .jsonObject:
            return .object(["type": .string("json_object")])
        case .jsonSchema(let name, let strict, let schema):
            var inner: [String: JSONValue] = [
                "name": .string(name ?? "response"),
                "schema": schema,
            ]
            if let strict { inner["strict"] = .bool(strict) }
            return .object(["type": .string("json_schema"), "json_schema": .object(inner)])
        }
    }

    // MARK: - Decoding

    static func decodeChatResult(_ data: Data, providerId: String) throws -> ChatResult {
        let root = try JSONDecoder().decode(JSONValue.self, from: data)
        let choice = root["choices"]?.arrayValue?.first
        guard let messageValue = choice?["message"], messageValue != .null else {
            throw ModelHitchError(
                code: .providerError,
                message: "Provider \"\(providerId)\" returned no message.",
                providerId: providerId
            )
        }
        let message = decodeAssistant(messageValue)
        let finishReason = choice?["finish_reason"]?.stringValue ?? "stop"
        return ChatResult(
            message: message,
            finishReason: finishReason,
            usage: decodeUsage(root),
            responseId: root["id"]?.stringValue,
            raw: root
        )
    }

    static func decodeAssistant(_ value: JSONValue?) -> ModelMessage {
        let content = value?["content"]?.stringValue ?? ""
        let toolCalls: [ToolCall]? = value?["tool_calls"]?.arrayValue?.enumerated().map {
            index, call in
            let callId = call["id"]?.stringValue ?? "call_\(index)"
            let name = call["function"]?["name"]?.stringValue ?? "unknown"
            let argumentsString = call["function"]?["arguments"]?.stringValue ?? "{}"
            let arguments =
                (try? JSONDecoder().decode(JSONValue.self, from: Data(argumentsString.utf8)))
                ?? .object([:])
            return ToolCall(id: callId, name: name, arguments: arguments)
        }
        return ModelMessage.assistant(
            content,
            toolCalls: (toolCalls?.isEmpty == false) ? toolCalls : nil,
            reasoningContent: value?["reasoning_content"]?.stringValue
        )
    }

    static func decodeUsage(_ root: JSONValue) -> Usage? {
        guard let usage = root["usage"], usage != .null else { return nil }
        return Usage(
            inputTokens: usage["prompt_tokens"]?.intValue,
            outputTokens: usage["completion_tokens"]?.intValue,
            totalTokens: usage["total_tokens"]?.intValue
        )
    }

    // MARK: - Errors

    static func validate(_ response: URLResponse, providerId: String, body: Data?) throws {
        guard let http = response as? HTTPURLResponse else { return }
        guard (200..<300).contains(http.statusCode) else {
            let text = body.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            throw mapHTTPError(
                status: http.statusCode, body: text, headers: http, providerId: providerId)
        }
    }

    static func mapHTTPError(
        status: Int,
        body: String,
        headers: HTTPURLResponse?,
        providerId: String
    ) -> ModelHitchError {
        let code: ModelHitchErrorCode
        switch status {
        case 401, 403: code = .invalidAPIKey
        case 429: code = .rateLimited
        case 404: code = .modelNotFound
        case 400, 422: code = .badRequest
        default: code = .providerError
        }
        let retryAfterMs =
            headers
            .flatMap { $0.value(forHTTPHeaderField: "Retry-After") }
            .flatMap { Self.parseRetryAfter($0) }
        let detail = body.isEmpty ? "" : ": \(body)"
        return ModelHitchError(
            code: code,
            message: "Provider \"\(providerId)\" returned HTTP \(status)\(detail)",
            status: status,
            providerId: providerId,
            retryAfterMs: retryAfterMs
        )
    }

    /// Normalize a thrown transport/decode error into a ``ModelHitchError`` so
    /// callers see one public error type. `URLError` becomes
    /// ``ModelHitchErrorCode/networkError``; `DecodingError` becomes
    /// ``ModelHitchErrorCode/providerError`` (malformed provider response).
    static func mapError(_ error: Error, providerId: String) -> Error {
        if error is ModelHitchError { return error }
        if let urlError = error as? URLError {
            let message =
                "Network error contacting provider \"\(providerId)\": "
                + urlError.localizedDescription
            return ModelHitchError(code: .networkError, message: message, providerId: providerId)
        }
        if error is DecodingError {
            return ModelHitchError(
                code: .providerError,
                message: "Provider \"\(providerId)\" returned a malformed response.",
                providerId: providerId
            )
        }
        return error
    }

    /// Parse a `Retry-After` header into milliseconds, mirroring the TypeScript
    /// `parseRetryAfter`: whole or fractional delta-seconds, or an HTTP-date.
    /// Returns `nil` for absent, malformed, negative, or already-expired values.
    static func parseRetryAfter(_ value: String?) -> Int? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        // Delta-seconds (whole or fractional), per RFC 9110.
        if trimmed.range(of: #"^\d+(\.\d+)?$"#, options: .regularExpression) != nil {
            guard let seconds = Double(trimmed), seconds >= 0, seconds.isFinite else { return nil }
            return Int(ceil(seconds * 1000))
        }

        // HTTP-date (RFC 1123 / 850 / asctime).
        if let date = Self.parseHTTPDate(trimmed) {
            let ms = Int((date.timeIntervalSinceNow * 1000).rounded(.up))
            return ms > 0 ? ms : nil
        }
        return nil
    }

    private static func parseHTTPDate(_ string: String) -> Date? {
        let formats = [
            "EEE, dd MMM yyyy HH:mm:ss z",  // RFC 1123
            "EEEE, dd-MMM-yy HH:mm:ss z",  // RFC 850
            "EEE MMM d HH:mm:ss yyyy",  // asctime
        ]
        for format in formats {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = TimeZone(secondsFromGMT: 0)
            formatter.dateFormat = format
            if let date = formatter.date(from: string) { return date }
        }
        return nil
    }

    static func endpoint(_ base: String, _ path: String) -> URL? {
        var normalized = base
        if !normalized.hasSuffix("/") { normalized += "/" }
        return URL(string: normalized + path)
    }
}
