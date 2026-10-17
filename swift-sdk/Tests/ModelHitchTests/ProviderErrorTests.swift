import Foundation
import Testing

@testable import ModelHitch

struct ProviderErrorTests {
    private func make(_ status: Int, retryAfter: String? = nil) -> HTTPURLResponse {
        HTTPURLResponse(
            url: URL(string: "https://example.com")!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: retryAfter.map { ["Retry-After": $0] }
        )!
    }

    private func mapError(_ status: Int, retryAfter: String? = nil) -> ModelHitchError {
        OpenAICompatibleProvider.mapHTTPError(
            status: status,
            body: "",
            headers: make(status, retryAfter: retryAfter),
            providerId: "test"
        )
    }

    @Test func mapHTTPErrorCodes() {
        #expect(mapError(401).code == .invalidAPIKey)
        #expect(mapError(403).code == .invalidAPIKey)
        #expect(mapError(429).code == .rateLimited)
        #expect(mapError(404).code == .modelNotFound)
        #expect(mapError(400).code == .badRequest)
        #expect(mapError(422).code == .badRequest)
        #expect(mapError(500).code == .providerError)
    }

    @Test func retryAfterParsedToMs() {
        #expect(mapError(429, retryAfter: "2").retryAfterMs == 2000)
    }

    @Test func validateAccepts200() {
        #expect(throws: Never.self) {
            try OpenAICompatibleProvider.validate(make(200), providerId: "test", body: nil)
        }
    }

    @Test func validateRejects429WithRetryAfter() {
        var caught: ModelHitchError?
        do {
            try OpenAICompatibleProvider.validate(
                make(429, retryAfter: "3"), providerId: "test", body: nil)
        } catch let error as ModelHitchError {
            caught = error
        } catch {
            Issue.record("unexpected error type: \(error)")
        }
        let error =
            caught
            ?? ModelHitchError(
                code: .providerError, message: "uncaught", status: nil, providerId: "test",
                retryAfterMs: nil)
        #expect(error.code == .rateLimited)
        #expect(error.status == 429)
        #expect(error.retryAfterMs == 3000)
    }

    @Test func endpointNormalization() {
        #expect(
            OpenAICompatibleProvider.endpoint("https://api.x.com", "chat/completions")?
                .absoluteString == "https://api.x.com/chat/completions")
        #expect(
            OpenAICompatibleProvider.endpoint("https://api.x.com/", "chat/completions")?
                .absoluteString == "https://api.x.com/chat/completions")
    }
}
