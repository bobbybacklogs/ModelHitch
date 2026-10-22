import Foundation
import Testing

@testable import ModelHitch

struct ResponseFormatTests {
    private func body(responseFormat: ResponseFormat) -> JSONValue {
        OpenAICompatibleProvider.requestBody(
            ChatParams(model: "m", messages: [.user("hi")], responseFormat: responseFormat),
            stream: false
        )
    }

    // MARK: - P2.3: json_schema name defaults to "response"

    @Test func jsonSchemaDefaultsNameToResponse() {
        let root = body(
            responseFormat: .jsonSchema(
                name: nil, strict: nil,
                schema: .object(["type": .string("object")])))
        #expect(root["response_format"]?["type"]?.stringValue == "json_schema")
        #expect(root["response_format"]?["json_schema"]?["name"]?.stringValue == "response")
    }

    @Test func jsonSchemaPreservesExplicitNameAndStrict() {
        let root = body(
            responseFormat: .jsonSchema(
                name: "my_schema", strict: true,
                schema: .object(["type": .string("object")])))
        #expect(root["response_format"]?["json_schema"]?["name"]?.stringValue == "my_schema")
        #expect(root["response_format"]?["json_schema"]?["strict"]?.boolValue == true)
    }
}
