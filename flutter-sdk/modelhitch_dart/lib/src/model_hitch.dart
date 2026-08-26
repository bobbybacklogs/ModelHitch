import 'errors.dart';
import 'keystore.dart';
import 'provider.dart';
import 'providers/defaults.dart';
import 'types.dart';

final class ModelHitch {
  ModelHitch({
    List<Provider>? providers,
    this.keyStore,
    this.defaultProviderId,
    this.defaultModel,
  }) : providers = List.unmodifiable(providers ?? DefaultProviders.all) {
    if (this.providers.isEmpty) {
      throw ArgumentError.value(
          providers, 'providers', 'At least one provider is required.');
    }
    final ids = this.providers.map((provider) => provider.id).toSet();
    if (ids.length != this.providers.length) {
      throw ArgumentError.value(
          providers, 'providers', 'Provider ids must be unique.');
    }
  }

  final List<Provider> providers;
  final KeyStore? keyStore;
  final String? defaultProviderId;
  final String? defaultModel;

  Provider provider(String id) {
    for (final provider in providers) {
      if (provider.id == id) return provider;
    }
    throw ModelHitchException(
      code: ModelHitchErrorCode.providerNotFound,
      message:
          'Unknown provider "$id". Available: ${providers.map((provider) => provider.id).join(', ')}',
      providerId: id,
    );
  }

  Future<ChatResult> chat(ChatRequest request) async {
    final resolved = await _resolve(request);
    return resolved.provider.chat(resolved.params, resolved.credentials);
  }

  Stream<StreamChunk> stream(ChatRequest request) async* {
    final resolved = await _resolve(request);
    yield* resolved.provider.stream(resolved.params, resolved.credentials);
  }

  Future<List<ModelInfo>> listModels(String providerId,
      {String? apiKey, String? baseUrl}) {
    return provider(providerId)
        .listModels(ProviderCredentials(apiKey: apiKey, baseUrl: baseUrl));
  }

  Future<_ResolvedRequest> _resolve(ChatRequest request) async {
    final selected = request.provider != null
        ? provider(request.provider!)
        : defaultProviderId != null
            ? provider(defaultProviderId!)
            : providers.first;
    final hasExplicitCredentials =
        request.apiKey != null || request.baseUrl != null;
    final credentials = hasExplicitCredentials
        ? ProviderCredentials(apiKey: request.apiKey, baseUrl: request.baseUrl)
        : ProviderCredentials(apiKey: await keyStore?.get(selected.id));
    return _ResolvedRequest(
      selected,
      ChatParams(
        model: request.model ?? defaultModel ?? selected.defaultModel,
        messages: request.messages,
        tools: request.tools,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        stop: request.stop,
        toolChoice: request.toolChoice,
        responseFormat: request.responseFormat,
      ),
      credentials,
    );
  }
}

final class _ResolvedRequest {
  const _ResolvedRequest(this.provider, this.params, this.credentials);

  final Provider provider;
  final ChatParams params;
  final ProviderCredentials credentials;
}
