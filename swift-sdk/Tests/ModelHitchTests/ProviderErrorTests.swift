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

    // MARK: - P2.2: Retry-After parsing (integer, fractional, HTTP-date, negatives)

    @Test func parseRetryAfterDeltaSeconds() {
        #expect(OpenAICompatibleProvider.parseRetryAfter("45") == 45_000)
        #expect(OpenAICompatibleProvider.parseRetryAfter("2") == 2_000)
        #expect(OpenAICompatibleProvider.parseRetryAfter("0") == 0)
    }

    @Test func parseRetryAfterFractionalSeconds() {
        #expect(OpenAICompatibleProvider.parseRetryAfter("0.5") == 500)
        #expect(OpenAICompatibleProvider.parseRetryAfter("1.25") == 1_250)
        #expect(OpenAICompatibleProvider.parseRetryAfter("2.001") == 2_001)
    }

    @Test func parseRetryAfterRejectsNegativeAndMalformed() {
        #expect(OpenAICompatibleProvider.parseRetryAfter("-1") == nil)
        #expect(OpenAICompatibleProvider.parseRetryAfter("abc") == nil)
        #expect(OpenAICompatibleProvider.parseRetryAfter("") == nil)
        #expect(OpenAICompatibleProvider.parseRetryAfter("   ") == nil)
        #expect(OpenAICompatibleProvider.parseRetryAfter(nil) == nil)
    }

    @Test func parseRetryAfterHTTPDate() {
        // A far-future HTTP-date resolves to a positive millisecond wait.
        #expect(OpenAICompatibleProvider.parseRetryAfter("Wed, 21 Oct 2099 07:28:00 GMT") != nil)
        #expect(OpenAICompatibleProvider.parseRetryAfter("Wed, 21 Oct 2099 07:28:00 GMT")! > 0)
        // An already-expired date resolves to nil.
        #expect(OpenAICompatibleProvider.parseRetryAfter("Wed, 21 Oct 2000 07:28:00 GMT") == nil)
    }

    @Test func mapHTTPErrorHonorsRetryAfterForms() {
        #expect(mapError(429, retryAfter: "0.25").retryAfterMs == 250)
        #expect(mapError(429, retryAfter: "-1").retryAfterMs == nil)
        #expect(mapError(429, retryAfter: "nonsense").retryAfterMs == nil)
    }

    // MARK: - P2.1: error taxonomy — one public error type

    @Test func mapErrorWrapsURLErrorAsNetworkError() {
        let wrapped = OpenAICompatibleProvider.mapError(
            URLError(.cannotConnectToHost), providerId: "test")
        guard let error = wrapped as? ModelHitchError else {
            Issue.record("expected ModelHitchError, got \(type(of: wrapped))")
            return
        }
        #expect(error.code == .networkError)
        #expect(error.providerId == "test")
    }

    @Test func mapErrorWrapsDecodingErrorAsProviderError() {
        let wrapped = OpenAICompatibleProvider.mapError(
            DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "bad")),
            providerId: "test"
        )
        guard let error = wrapped as? ModelHitchError else {
            Issue.record("expected ModelHitchError, got \(type(of: wrapped))")
            return
        }
        #expect(error.code == .providerError)
        #expect(error.providerId == "test")
    }

    @Test func mapErrorPassesThroughModelHitchError() {
        let original = ModelHitchError(
            code: .rateLimited, message: "rate limited", status: 429, providerId: "test",
            retryAfterMs: 1_000)
        let wrapped = OpenAICompatibleProvider.mapError(original, providerId: "test")
        guard let error = wrapped as? ModelHitchError else {
            Issue.record("expected ModelHitchError")
            return
        }
        #expect(error.code == .rateLimited)
        #expect(error.retryAfterMs == 1_000)
    }
}
