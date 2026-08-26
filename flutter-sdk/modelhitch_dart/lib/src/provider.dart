import 'types.dart';

abstract interface class Provider {
  String get id;
  String get name;
  String get defaultModel;
  Capabilities get capabilities;

  Future<ChatResult> chat(ChatParams params, ProviderCredentials credentials);
  Stream<StreamChunk> stream(
      ChatParams params, ProviderCredentials credentials);
  Future<List<ModelInfo>> listModels(ProviderCredentials credentials);
}
