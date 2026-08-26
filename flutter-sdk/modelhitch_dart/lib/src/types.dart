typedef JsonMap = Map<String, Object?>;

sealed class MessageContent {
  const MessageContent();

  factory MessageContent.text(String value) = TextContent;
  factory MessageContent.parts(List<ContentPart> value) = PartsContent;
}

final class TextContent extends MessageContent {
  const TextContent(this.value);

  final String value;
}

final class PartsContent extends MessageContent {
  const PartsContent(this.value);

  final List<ContentPart> value;
}

sealed class ContentPart {
  const ContentPart();

  factory ContentPart.text(String text) = TextPart;
  factory ContentPart.imageUrl(String imageUrl) = ImageUrlPart;
  factory ContentPart.imageData(String data, String mimeType) = ImageDataPart;
}

final class TextPart extends ContentPart {
  const TextPart(this.text);

  final String text;
}

final class ImageUrlPart extends ContentPart {
  const ImageUrlPart(this.imageUrl);

  final String imageUrl;
}

final class ImageDataPart extends ContentPart {
  const ImageDataPart(this.data, this.mimeType);

  final String data;
  final String mimeType;
}

sealed class ModelMessage {
  const ModelMessage();

  factory ModelMessage.system(MessageContent content, {String? name}) =
      SystemMessage;
  factory ModelMessage.user(MessageContent content, {String? name}) =
      UserMessage;
  factory ModelMessage.assistant(MessageContent content,
      {List<ToolCall>? toolCalls}) = AssistantMessage;
  factory ModelMessage.tool(String content, String toolCallId) = ToolMessage;
}

final class SystemMessage extends ModelMessage {
  const SystemMessage(this.content, {this.name});

  final MessageContent content;
  final String? name;
}

final class UserMessage extends ModelMessage {
  const UserMessage(this.content, {this.name});

  final MessageContent content;
  final String? name;
}

final class AssistantMessage extends ModelMessage {
  const AssistantMessage(this.content, {this.toolCalls});

  final MessageContent content;
  final List<ToolCall>? toolCalls;
}

final class ToolMessage extends ModelMessage {
  const ToolMessage(this.content, this.toolCallId);

  final String content;
  final String toolCallId;
}

final class ToolDefinition {
  const ToolDefinition({required this.name, this.description, this.parameters});

  final String name;
  final String? description;
  final JsonMap? parameters;
}

final class ToolCall {
  const ToolCall({
    required this.id,
    required this.name,
    required this.arguments,
    this.thoughtSignature,
  });

  final String id;
  final String name;
  final JsonMap arguments;
  final String? thoughtSignature;
}

sealed class ToolChoice {
  const ToolChoice();

  static const auto = AutoToolChoice();
  static const none = NoneToolChoice();
  static const required = RequiredToolChoice();
  factory ToolChoice.function(String name) = FunctionToolChoice;
}

final class AutoToolChoice extends ToolChoice {
  const AutoToolChoice();
}

final class NoneToolChoice extends ToolChoice {
  const NoneToolChoice();
}

final class RequiredToolChoice extends ToolChoice {
  const RequiredToolChoice();
}

final class FunctionToolChoice extends ToolChoice {
  const FunctionToolChoice(this.name);

  final String name;
}

sealed class ResponseFormat {
  const ResponseFormat();

  static const text = TextResponseFormat();
  static const json = JsonResponseFormat();
  factory ResponseFormat.jsonSchema(
    JsonMap schema, {
    String name = 'response',
    bool strict = false,
  }) =>
      JsonSchemaResponseFormat(schema, name: name, strict: strict);
}

final class TextResponseFormat extends ResponseFormat {
  const TextResponseFormat();
}

final class JsonResponseFormat extends ResponseFormat {
  const JsonResponseFormat();
}

final class JsonSchemaResponseFormat extends ResponseFormat {
  const JsonSchemaResponseFormat(this.schema,
      {this.name = 'response', this.strict = false});

  final JsonMap schema;
  final String name;
  final bool strict;
}

final class ChatRequest {
  const ChatRequest({
    required this.messages,
    this.provider,
    this.model,
    this.apiKey,
    this.baseUrl,
    this.tools,
    this.temperature,
    this.maxTokens,
    this.stop,
    this.toolChoice,
    this.responseFormat,
  });

  final List<ModelMessage> messages;
  final String? provider;
  final String? model;
  final String? apiKey;
  final String? baseUrl;
  final List<ToolDefinition>? tools;
  final double? temperature;
  final int? maxTokens;
  final List<String>? stop;
  final ToolChoice? toolChoice;
  final ResponseFormat? responseFormat;
}

final class ChatParams {
  const ChatParams({
    required this.model,
    required this.messages,
    this.tools,
    this.temperature,
    this.maxTokens,
    this.stop,
    this.toolChoice,
    this.responseFormat,
  });

  final String model;
  final List<ModelMessage> messages;
  final List<ToolDefinition>? tools;
  final double? temperature;
  final int? maxTokens;
  final List<String>? stop;
  final ToolChoice? toolChoice;
  final ResponseFormat? responseFormat;
}

final class Usage {
  const Usage({this.inputTokens, this.outputTokens, this.totalTokens});

  final int? inputTokens;
  final int? outputTokens;
  final int? totalTokens;
}

final class ChatResult {
  const ChatResult(
      {required this.message,
      required this.finishReason,
      this.usage,
      this.raw});

  final AssistantMessage message;
  final String finishReason;
  final Usage? usage;
  final JsonMap? raw;
}

sealed class StreamChunk {
  const StreamChunk();
}

final class TextDelta extends StreamChunk {
  const TextDelta(this.text);

  final String text;
}

final class ToolCallStart extends StreamChunk {
  const ToolCallStart(this.id, this.name, {this.thoughtSignature});

  final String id;
  final String name;
  final String? thoughtSignature;
}

final class ToolCallArgumentsDelta extends StreamChunk {
  const ToolCallArgumentsDelta(this.id, this.argumentsDelta);

  final String id;
  final String argumentsDelta;
}

final class ToolCallEnd extends StreamChunk {
  const ToolCallEnd(this.id);

  final String id;
}

final class Finish extends StreamChunk {
  const Finish(this.finishReason, {this.usage, this.responseId});

  final String finishReason;
  final Usage? usage;
  final String? responseId;
}

final class Capabilities {
  const Capabilities({
    required this.streaming,
    required this.toolCalling,
    required this.vision,
    required this.embeddings,
    this.maxContextTokens,
  });

  final bool streaming;
  final bool toolCalling;
  final bool vision;
  final bool embeddings;
  final int? maxContextTokens;
}

final class ProviderCredentials {
  const ProviderCredentials({this.apiKey, this.baseUrl});

  final String? apiKey;
  final String? baseUrl;
}

final class ModelInfo {
  const ModelInfo({required this.id, this.name, this.contextLength});

  final String id;
  final String? name;
  final int? contextLength;
}
