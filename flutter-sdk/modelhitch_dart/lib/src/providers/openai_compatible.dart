import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../errors.dart';
import '../provider.dart';
import '../types.dart';

final class OpenAICompatibleConfig {
  const OpenAICompatibleConfig({
    required this.id,
    required this.name,
    required this.defaultModel,
    required this.baseUrl,
    this.requiresKey = true,
    this.headers = const {},
    this.capabilities = const Capabilities(
        streaming: true, toolCalling: true, vision: true, embeddings: false),
  });

  final String id;
  final String name;
  final String defaultModel;
  final String baseUrl;
  final bool requiresKey;
  final Map<String, String> headers;
  final Capabilities capabilities;
}

final class OpenAICompatibleProvider implements Provider {
  OpenAICompatibleProvider(this.config, {http.Client? client})
      : _client = client ?? http.Client();

  final OpenAICompatibleConfig config;
  final http.Client _client;

  @override
  String get id => config.id;

  @override
  String get name => config.name;

  @override
  String get defaultModel => config.defaultModel;

  @override
  Capabilities get capabilities => config.capabilities;

  @override
  Future<ChatResult> chat(
      ChatParams params, ProviderCredentials credentials) async {
    final response =
        await _send('chat/completions', params, credentials, stream: false);
    final body = await response.stream.bytesToString();
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw _httpError(response, body);
    }
    return _parseChatResult(_decodeObject(body));
  }

  @override
  Stream<StreamChunk> stream(
      ChatParams params, ProviderCredentials credentials) async* {
    final response =
        await _send('chat/completions', params, credentials, stream: true);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw _httpError(response, await response.stream.bytesToString());
    }
    final state = _StreamState();
    final dataLines = <String>[];
    await for (final line in response.stream
        .transform(utf8.decoder)
        .transform(const LineSplitter())) {
      if (line.isEmpty) {
        yield* _parseSseEvent(dataLines, state);
        dataLines.clear();
      } else if (line.startsWith('data:')) {
        dataLines.add(line.substring(5).replaceFirst(RegExp(r'^ '), ''));
      }
    }
    yield* _parseSseEvent(dataLines, state);
    final finish = state.finish(force: true);
    if (finish != null) yield finish;
  }

  @override
  Future<List<ModelInfo>> listModels(ProviderCredentials credentials) async {
    final request = http.Request('GET', _uriFor('models', credentials));
    request.headers.addAll(_headers(credentials));
    final response = await _sendRequest(request);
    final body = await response.stream.bytesToString();
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw _httpError(response, body);
    }
    final data = _decodeObject(body)['data'];
    if (data is! List<Object?>) return const [];
    return data
        .whereType<Map<Object?, Object?>>()
        .map((model) {
          final id = model['id'];
          return ModelInfo(
            id: id is String ? id : '',
            name: model['name'] as String?,
            contextLength: model['context_length'] as int?,
          );
        })
        .where((model) => model.id.isNotEmpty)
        .toList();
  }

  Future<http.StreamedResponse> _send(
      String path, ChatParams params, ProviderCredentials credentials,
      {required bool stream}) {
    final request = http.Request('POST', _uriFor(path, credentials));
    request.headers.addAll(_headers(credentials));
    request.body = jsonEncode(_requestBody(params, stream: stream));
    return _sendRequest(request);
  }

  Future<http.StreamedResponse> _sendRequest(http.BaseRequest request) async {
    try {
      return await _client.send(request);
    } on Object catch (error) {
      throw ModelHitchException(
        code: ModelHitchErrorCode.networkError,
        message: 'Request to provider "$id" failed: $error',
        providerId: id,
        cause: error,
      );
    }
  }

  Uri _uriFor(String path, ProviderCredentials credentials) {
    final baseUrl = (credentials.baseUrl ?? config.baseUrl)
        .replaceFirst(RegExp(r'/+$'), '');
    return Uri.parse('$baseUrl/$path');
  }

  Map<String, String> _headers(ProviderCredentials credentials) {
    final apiKey = credentials.apiKey;
    if (config.requiresKey && (apiKey == null || apiKey.isEmpty)) {
      throw ModelHitchException(
        code: ModelHitchErrorCode.missingApiKey,
        message: 'Provider "$id" requires an API key.',
        providerId: id,
      );
    }
    return {
      'content-type': 'application/json',
      ...config.headers,
      if (apiKey != null && apiKey.isNotEmpty)
        'authorization': 'Bearer $apiKey',
    };
  }

  Map<String, Object?> _requestBody(ChatParams params,
          {required bool stream}) =>
      {
        'model': params.model,
        'messages': params.messages.map(_messageToJson).toList(),
        if (params.tools != null && params.tools!.isNotEmpty)
          'tools': params.tools!
              .map((tool) => {
                    'type': 'function',
                    'function': {
                      'name': tool.name,
                      if (tool.description != null)
                        'description': tool.description,
                      if (tool.parameters != null)
                        'parameters': tool.parameters,
                    },
                  })
              .toList(),
        if (params.temperature != null) 'temperature': params.temperature,
        if (params.maxTokens != null) 'max_tokens': params.maxTokens,
        if (params.stop != null) 'stop': params.stop,
        if (params.toolChoice != null)
          'tool_choice': _toolChoiceToJson(params.toolChoice!),
        if (params.responseFormat != null)
          'response_format': _responseFormatToJson(params.responseFormat!),
        if (stream) ...{
          'stream': true,
          'stream_options': {'include_usage': true}
        },
      };

  Map<String, Object?> _messageToJson(ModelMessage message) =>
      switch (message) {
        SystemMessage(:final content, :final name) => {
            'role': 'system',
            'content': _contentToJson(content),
            if (name != null) 'name': name
          },
        UserMessage(:final content, :final name) => {
            'role': 'user',
            'content': _contentToJson(content),
            if (name != null) 'name': name
          },
        AssistantMessage(:final content, :final toolCalls) => {
            'role': 'assistant',
            'content': _contentToJson(content),
            if (toolCalls != null)
              'tool_calls': toolCalls
                  .map((call) => {
                        'id': call.id,
                        'type': 'function',
                        'function': {
                          'name': call.name,
                          'arguments': jsonEncode(call.arguments)
                        },
                      })
                  .toList(),
          },
        ToolMessage(:final content, :final toolCallId) => {
            'role': 'tool',
            'content': content,
            'tool_call_id': toolCallId
          },
      };

  Object _contentToJson(MessageContent content) => switch (content) {
        TextContent(:final value) => value,
        PartsContent(:final value) => value
            .map((part) => switch (part) {
                  TextPart(:final text) => {'type': 'text', 'text': text},
                  ImageUrlPart(:final imageUrl) => {
                      'type': 'image_url',
                      'image_url': {'url': imageUrl}
                    },
                  ImageDataPart(:final data, :final mimeType) => {
                      'type': 'image_url',
                      'image_url': {'url': 'data:$mimeType;base64,$data'}
                    },
                })
            .toList(),
      };

  Object _toolChoiceToJson(ToolChoice choice) => switch (choice) {
        AutoToolChoice() => 'auto',
        NoneToolChoice() => 'none',
        RequiredToolChoice() => 'required',
        FunctionToolChoice(:final name) => {
            'type': 'function',
            'function': {'name': name}
          },
      };

  Object _responseFormatToJson(ResponseFormat format) => switch (format) {
        TextResponseFormat() => {'type': 'text'},
        JsonResponseFormat() => {'type': 'json_object'},
        JsonSchemaResponseFormat(:final schema, :final name, :final strict) => {
            'type': 'json_schema',
            'json_schema': {'name': name, 'strict': strict, 'schema': schema}
          },
      };

  ChatResult _parseChatResult(JsonMap root) {
    final choices = root['choices'];
    if (choices is! List<Object?> ||
        choices.isEmpty ||
        choices.first is! Map<Object?, Object?>) {
      throw _providerError('returned no message');
    }
    final choice = choices.first as Map<Object?, Object?>;
    final message = choice['message'];
    if (message is! Map<Object?, Object?>) {
      throw _providerError('returned no message');
    }
    final toolCalls = _toolCalls(message['tool_calls']);
    return ChatResult(
      message: AssistantMessage(
          MessageContent.text(message['content'] as String? ?? ''),
          toolCalls: toolCalls.isEmpty ? null : toolCalls),
      finishReason: _finishReason(choice['finish_reason'] as String?),
      usage: _usage(root['usage']),
      raw: root,
    );
  }

  Stream<StreamChunk> _parseSseEvent(
      List<String> dataLines, _StreamState state) async* {
    if (dataLines.isEmpty) return;
    final payload = dataLines.join('\n');
    if (payload.isEmpty || payload == '[DONE]') return;
    JsonMap root;
    try {
      root = _decodeObject(payload);
    } on Object {
      return;
    }
    final error = root['error'];
    if (error is Map<Object?, Object?>) {
      throw ModelHitchException(
          code: ModelHitchErrorCode.providerError,
          message:
              'Provider "$id" stream failed: ${error['message'] ?? 'unknown error'}',
          providerId: id);
    }
    state.usage = _usage(root['usage']) ?? state.usage;
    final choices = root['choices'];
    if (choices is! List<Object?> ||
        choices.isEmpty ||
        choices.first is! Map<Object?, Object?>) {
      return;
    }
    final choice = choices.first as Map<Object?, Object?>;
    final delta = choice['delta'] is Map<Object?, Object?>
        ? choice['delta'] as Map<Object?, Object?>
        : const <Object?, Object?>{};
    final content = delta['content'];
    if (content is String && content.isNotEmpty) yield TextDelta(content);
    final calls = delta['tool_calls'];
    if (calls is List<Object?>) {
      for (final entry in calls.whereType<Map<Object?, Object?>>()) {
        final index = entry['index'] as int? ?? 0;
        final function = entry['function'] is Map<Object?, Object?>
            ? entry['function'] as Map<Object?, Object?>
            : const <Object?, Object?>{};
        final callId =
            entry['id'] as String? ?? state.toolCallIds[index] ?? 'call_$index';
        final callName = function['name'];
        if (callName is String) {
          state.toolCallIds[index] = callId;
          yield ToolCallStart(callId, callName);
        }
        final arguments = function['arguments'];
        if (arguments is String && arguments.isNotEmpty) {
          yield ToolCallArgumentsDelta(callId, arguments);
        }
      }
    }
    final reason = choice['finish_reason'];
    if (reason is String) {
      if (reason == 'tool_calls') {
        for (final callId in state.toolCallIds.values) {
          yield ToolCallEnd(callId);
        }
      }
      state.finishReason = _finishReason(reason);
    }
  }

  List<ToolCall> _toolCalls(Object? value) {
    if (value is! List<Object?>) return const [];
    return value
        .whereType<Map<Object?, Object?>>()
        .toList()
        .asMap()
        .entries
        .map((entry) {
      final call = entry.value;
      final function = call['function'] is Map<Object?, Object?>
          ? call['function'] as Map<Object?, Object?>
          : const <Object?, Object?>{};
      return ToolCall(
        id: call['id'] as String? ?? 'call_${entry.key}',
        name: function['name'] as String? ?? 'unknown',
        arguments: _decodeObjectOrEmpty(function['arguments']),
      );
    }).toList();
  }

  Usage? _usage(Object? value) {
    if (value is! Map<Object?, Object?>) return null;
    return Usage(
      inputTokens:
          value['prompt_tokens'] as int? ?? value['input_tokens'] as int?,
      outputTokens:
          value['completion_tokens'] as int? ?? value['output_tokens'] as int?,
      totalTokens: value['total_tokens'] as int?,
    );
  }

  String _finishReason(String? value) =>
      value == 'tool_calls' ? 'tool-calls' : value ?? 'stop';

  JsonMap _decodeObject(String value) =>
      Map<String, Object?>.from(jsonDecode(value) as Map<Object?, Object?>);

  JsonMap _decodeObjectOrEmpty(Object? value) {
    if (value is! String) return const {};
    try {
      return _decodeObject(value);
    } on Object {
      return const {};
    }
  }

  ModelHitchException _providerError(String detail) => ModelHitchException(
      code: ModelHitchErrorCode.providerError,
      message: 'Provider "$id" $detail.',
      providerId: id);

  ModelHitchException _httpError(http.StreamedResponse response, String body) {
    final code = switch (response.statusCode) {
      401 || 403 => ModelHitchErrorCode.invalidApiKey,
      404 => ModelHitchErrorCode.modelNotFound,
      429 => ModelHitchErrorCode.rateLimited,
      >= 500 && <= 599 => ModelHitchErrorCode.providerError,
      _ => ModelHitchErrorCode.badRequest,
    };
    return ModelHitchException(
      code: code,
      message:
          'Provider "$id" returned HTTP ${response.statusCode}.${body.isEmpty ? '' : ' (${body.substring(0, body.length > 300 ? 300 : body.length)})'}',
      status: response.statusCode,
      providerId: id,
      retryAfter: _retryAfter(response.headers['retry-after']),
    );
  }

  Duration? _retryAfter(String? header) => header == null
      ? null
      : int.tryParse(header) == null
          ? null
          : Duration(seconds: int.parse(header));
}

final class _StreamState {
  final Map<int, String> toolCallIds = {};
  Usage? usage;
  String? finishReason;
  bool _finished = false;

  Finish? finish({bool force = false}) {
    if (_finished || (!force && finishReason == null)) return null;
    _finished = true;
    return Finish(finishReason ?? 'stop', usage: usage);
  }
}
