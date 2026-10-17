import Foundation

/// Consume a normalized ``StreamChunk`` stream and aggregate it into a
/// ``ChatResult``. Mirrors the TypeScript `aggregateStream` helper, letting
/// non-streaming callers share one code path with streaming providers.
public func aggregateStream(
    _ chunks: AsyncThrowingStream<StreamChunk, Error>
) async throws -> ChatResult {
    var text = ""
    var reasoning = ""
    var order: [String] = []
    var calls: [String: (id: String, name: String, args: String)] = [:]
    var finishReason = "stop"
    var usage: Usage?
    var responseId: String?

    for try await chunk in chunks {
        switch chunk {
        case .textDelta(let delta):
            text += delta
        case .reasoningDelta(let delta):
            reasoning += delta
        case .toolCallStart(let id, let name, _):
            if calls[id] == nil { order.append(id) }
            calls[id] = (id, name, calls[id]?.args ?? "")
        case .toolCallArgsDelta(let id, let delta):
            if var existing = calls[id] {
                existing.args += delta
                calls[id] = existing
            } else {
                order.append(id)
                calls[id] = (id, id, delta)
            }
        case .toolCallEnd:
            break
        case .finish(let reason, let chunkUsage, let chunkResponseId):
            finishReason = reason
            usage = chunkUsage
            responseId = chunkResponseId
        }
    }

    let toolCalls: [ToolCall] = order.compactMap { key in
        guard let call = calls[key] else { return nil }
        let arguments =
            (try? JSONDecoder().decode(JSONValue.self, from: Data(call.args.utf8))) ?? .object([:])
        return ToolCall(id: call.id, name: call.name, arguments: arguments)
    }

    let message = ModelMessage.assistant(
        text,
        toolCalls: toolCalls.isEmpty ? nil : toolCalls,
        reasoningContent: reasoning.isEmpty ? nil : reasoning
    )

    return ChatResult(
        message: message,
        finishReason: finishReason,
        usage: usage,
        responseId: responseId
    )
}
