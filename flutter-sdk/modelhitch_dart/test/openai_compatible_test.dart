import 'dart:convert';
import 'dart:io';

import 'package:modelhitch_dart/modelhitch_dart.dart';
import 'package:test/test.dart';

void main() {
  test('loads the shared OpenAI-compatible protocol fixture', () {
    final fixtureFile = File('../../conformance/openai-compatible-v1.json');
    final fixture =
        jsonDecode(fixtureFile.readAsStringSync()) as Map<String, Object?>;

    expect(fixture['version'], 1);
    expect((fixture['request'] as Map<String, Object?>)['path'],
        '/v1/chat/completions');
    expect((fixture['expectedStream'] as List<Object?>).last,
        isA<Map<String, Object?>>());
  });

  group('OpenAICompatibleProvider', () {
    test('chat resolves stored credentials and normalizes a response',
        () async {
      final server = await _TestServer.start((request) async {
        expect(request.headers.value(HttpHeaders.authorizationHeader),
            'Bearer stored-key');
        final requestBody = jsonDecode(await utf8.decoder.bind(request).join())
            as Map<String, Object?>;
        expect(requestBody['model'], 'test-model');
        request.response.headers.contentType = ContentType.json;
        request.response.write(
            '{"choices":[{"message":{"role":"assistant","content":"Hello Flutter"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}');
        await request.response.close();
      });
      addTearDown(server.close);
      final hitch = ModelHitch(
        providers: [_provider(server.url)],
        keyStore: MemoryKeyStore()..set('test', 'stored-key'),
      );

      final result = await hitch.chat(ChatRequest(
          messages: [ModelMessage.user(MessageContent.text('Hello'))]));

      expect((result.message.content as TextContent).value, 'Hello Flutter');
      expect(result.usage?.totalTokens, 5);
    });

    test('stream emits text and merges trailing usage into one finish event',
        () async {
      final server = await _TestServer.start((request) async {
        expect(request.headers.contentType?.mimeType, 'application/json');
        request.response.headers.contentType =
            ContentType('text', 'event-stream');
        request.response.write(
            'data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\n\n');
        request.response.write(
            'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n');
        request.response
            .write('data: {"choices":[],"usage":{"total_tokens":7}}\n\n');
        request.response.write('data: [DONE]\n\n');
        await request.response.close();
      });
      addTearDown(server.close);
      final hitch =
          ModelHitch(providers: [_provider(server.url, requiresKey: false)]);

      final chunks = await hitch
          .stream(ChatRequest(
              messages: [ModelMessage.user(MessageContent.text('Stream'))]))
          .toList();

      expect(chunks.whereType<TextDelta>().map((chunk) => chunk.text),
          ['Hel', 'lo']);
      final finishes = chunks.whereType<Finish>().toList();
      expect(finishes, hasLength(1));
      expect(finishes.single.finishReason, 'stop');
      expect(finishes.single.usage?.totalTokens, 7);
    });

    test('stream retains a tool call id across fragmented argument frames',
        () async {
      final server = await _TestServer.start((request) async {
        request.response.headers.contentType =
            ContentType('text', 'event-stream');
        request.response.write(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_real","function":{"name":"weather","arguments":""}}]},"finish_reason":null}]}\n\n');
        request.response.write(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]},"finish_reason":null}]}\n\n');
        request.response.write(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Tokyo\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n');
        request.response.write('data: [DONE]\n\n');
        await request.response.close();
      });
      addTearDown(server.close);
      final hitch =
          ModelHitch(providers: [_provider(server.url, requiresKey: false)]);

      final chunks = await hitch
          .stream(ChatRequest(
              messages: [ModelMessage.user(MessageContent.text('Weather'))]))
          .toList();

      expect(chunks.first,
          isA<ToolCallStart>().having((chunk) => chunk.id, 'id', 'call_real'));
      expect(
          chunks
              .whereType<ToolCallArgumentsDelta>()
              .map((chunk) => chunk.argumentsDelta)
              .join(),
          '{"city":"Tokyo"}');
      expect(chunks[chunks.length - 2],
          isA<ToolCallEnd>().having((chunk) => chunk.id, 'id', 'call_real'));
      expect((chunks.last as Finish).finishReason, 'tool-calls');
    });

    test('maps a rate limit response to a typed exception', () async {
      final server = await _TestServer.start((request) async {
        request.response.statusCode = HttpStatus.tooManyRequests;
        request.response.headers.set(HttpHeaders.retryAfterHeader, '3');
        await request.response.close();
      });
      addTearDown(server.close);
      final hitch =
          ModelHitch(providers: [_provider(server.url, requiresKey: false)]);

      await expectLater(
        () => hitch.chat(ChatRequest(
            messages: [ModelMessage.user(MessageContent.text('Wait'))])),
        throwsA(isA<ModelHitchException>()
            .having(
                (error) => error.code, 'code', ModelHitchErrorCode.rateLimited)
            .having((error) => error.retryAfter, 'retryAfter',
                const Duration(seconds: 3))),
      );
    });
  });
}

OpenAICompatibleProvider _provider(String baseUrl, {bool requiresKey = true}) =>
    OpenAICompatibleProvider(
      OpenAICompatibleConfig(
        id: 'test',
        name: 'Test',
        defaultModel: 'test-model',
        baseUrl: '$baseUrl/v1',
        requiresKey: requiresKey,
      ),
    );

final class _TestServer {
  _TestServer(this._server);

  final HttpServer _server;

  String get url => 'http://${_server.address.address}:${_server.port}';

  Future<void> close() => _server.close(force: true);

  static Future<_TestServer> start(
      Future<void> Function(HttpRequest request) handler) async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) async {
      try {
        await handler(request);
      } on Object {
        await request.response.close();
        rethrow;
      }
    });
    return _TestServer(server);
  }
}
