import Foundation
import Testing

@testable import ModelHitch

struct JSONValueTests {
    private func decode(_ raw: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(raw.utf8))
    }

    @Test func decodeEncodeRoundTrip() throws {
        let raw = #"{"a":1,"b":[true,null,"x"],"c":{"d":2.5}}"#
        let value = try decode(raw)
        #expect(value["a"]?.intValue == 1)
        #expect(value["b"]?.arrayValue?[0].boolValue == true)
        #expect(value["c"]?["d"]?.doubleValue == 2.5)
        #expect(value["b"]?.arrayValue?[1] == .null)
        let encoded = String(data: try JSONEncoder().encode(value), encoding: .utf8)
        #expect((try? decode(encoded ?? "")) == value)
    }

    @Test func decodeUsageShape() throws {
        let root = try decode(
            #"{"usage":{"prompt_tokens":5,"completion_tokens":7,"total_tokens":12}}"#)
        let usage = OpenAICompatibleProvider.decodeUsage(root)
        #expect(usage?.inputTokens == 5)
        #expect(usage?.outputTokens == 7)
        #expect(usage?.totalTokens == 12)
    }

    @Test func decodeChatResultAssistantMessage() throws {
        let data = Data(
            #"{"id":"chatcmpl-1","choices":[{"message":{"role":"assistant","content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":7,"total_tokens":12}}"#
                .utf8)
        let result = try OpenAICompatibleProvider.decodeChatResult(data)
        guard result.message.role == .assistant else {
            Issue.record("expected assistant message")
            return
        }
        #expect(result.message.content == .text("hi"))
        #expect(result.message.toolCalls == nil)
        #expect(result.finishReason == "stop")
        #expect(result.responseId == "chatcmpl-1")
        #expect(result.usage?.totalTokens == 12)
    }
}
