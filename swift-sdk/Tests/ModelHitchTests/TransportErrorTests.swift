import Foundation
import Testing

@testable import ModelHitch

/// A `URLProtocol` that fails every request with a `URLError`.
private final class FailingURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
    }
    override func stopLoading() {}
}

/// A `URLProtocol` that answers HTTP 200 with malformed JSON (not valid JSON).
private final class MalformedJSONProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("not json".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// A `URLProtocol` that answers HTTP 200 with valid JSON but no `choices`.
private final class MissingMessageProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"id":"chatcmpl-1"}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

struct TransportErrorTests {
    private func provider(_ protocolClass: AnyClass) -> OpenAICompatibleProvider {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [protocolClass]
        let session = URLSession(configuration: config)
        return OpenAICompatibleProvider(
            id: "test", name: "Test", baseURL: "https://example.com/v1",
            defaultModel: "m",
            capabilities: Capabilities(
                streaming: true, toolCalling: false, vision: false, embeddings: false),
            requiresKey: false,
            session: session
        )
    }

    private func params() -> ChatParams {
        ChatParams(model: "m", messages: [.user("hi")])
    }

    // MARK: - P2.1: network failures surface as `.networkError`

    @Test func chatMapsURLErrorToNetworkError() async {
        let provider = provider(FailingURLProtocol.self)
        do {
            _ = try await provider.chat(params(), credentials: ProviderCredentials())
            Issue.record("expected network-error")
        } catch let error as ModelHitchError {
            #expect(error.code == .networkError)
            #expect(error.providerId == "test")
        } catch {
            Issue.record("unexpected error type: \(error)")
        }
    }

    // MARK: - P2.1: decode failures surface as `.providerError`

    @Test func chatMapsMalformedJSONToProviderError() async {
        let provider = provider(MalformedJSONProtocol.self)
        do {
            _ = try await provider.chat(params(), credentials: ProviderCredentials())
            Issue.record("expected provider-error")
        } catch let error as ModelHitchError {
            #expect(error.code == .providerError)
            #expect(error.providerId == "test")
        } catch {
            Issue.record("unexpected error type: \(error)")
        }
    }

    // MARK: - P2.4: malformed 200 surfaces as `.providerError`, end to end

    @Test func chatThrowsProviderErrorOnMissingMessage() async {
        let provider = provider(MissingMessageProtocol.self)
        do {
            _ = try await provider.chat(params(), credentials: ProviderCredentials())
            Issue.record("expected provider-error")
        } catch let error as ModelHitchError {
            #expect(error.code == .providerError)
            #expect(error.providerId == "test")
        } catch {
            Issue.record("unexpected error type: \(error)")
        }
    }
}
