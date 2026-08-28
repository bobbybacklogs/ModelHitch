namespace ModelHitch;

public sealed class ModelHitchClient
{
    private readonly Dictionary<string, IModelProvider> providers;

    public ModelHitchClient(
        IEnumerable<IModelProvider> providers,
        string? defaultProviderId = null,
        string? defaultModel = null)
    {
        this.providers = providers.ToDictionary(provider => provider.Id, StringComparer.Ordinal);
        if (this.providers.Count == 0) throw new ArgumentException("At least one provider is required.", nameof(providers));
        if (this.providers.Count != providers.Count()) throw new ArgumentException("Provider ids must be unique.", nameof(providers));
        DefaultProviderId = defaultProviderId;
        DefaultModel = defaultModel;
    }

    public string? DefaultProviderId { get; }
    public string? DefaultModel { get; }

    public static ModelHitchClient ForBridge(HttpClient httpClient, Uri baseUrl, string model, string? apiKey = null)
    {
        var provider = new OpenAICompatibleProvider("bridge", model, httpClient, baseUrl, requiresApiKey: false, apiKey: apiKey);
        return new ModelHitchClient([provider], "bridge", model);
    }

    public Task<ChatResult> ChatAsync(ChatRequest request, CancellationToken cancellationToken = default)
    {
        var resolved = Resolve(request);
        return resolved.Provider.ChatAsync(resolved.Parameters, resolved.Credentials, cancellationToken);
    }

    public IAsyncEnumerable<StreamChunk> StreamAsync(ChatRequest request, CancellationToken cancellationToken = default)
    {
        var resolved = Resolve(request);
        return resolved.Provider.StreamAsync(resolved.Parameters, resolved.Credentials, cancellationToken);
    }

    public Task<IReadOnlyList<ModelInfo>> ListModelsAsync(string providerId, string? apiKey = null, Uri? baseUrl = null, CancellationToken cancellationToken = default)
    {
        return GetProvider(providerId).ListModelsAsync(new ProviderCredentials(apiKey, baseUrl), cancellationToken);
    }

    private IModelProvider GetProvider(string id) => providers.TryGetValue(id, out var provider)
        ? provider
        : throw new ModelHitchException("provider-not-found", $"Unknown provider '{id}'. Available: {string.Join(", ", providers.Keys)}.", id);

    private (IModelProvider Provider, ChatParameters Parameters, ProviderCredentials Credentials) Resolve(ChatRequest request)
    {
        var provider = request.Provider is not null ? GetProvider(request.Provider) : GetProvider(DefaultProviderId ?? providers.Keys.First());
        var parameters = new ChatParameters(
            request.Model ?? DefaultModel ?? provider.DefaultModel,
            request.Messages,
            request.Tools,
            request.Temperature,
            request.MaxTokens,
            request.Stop,
            request.ToolChoice);
        return (provider, parameters, new ProviderCredentials(request.ApiKey, request.BaseUrl));
    }
}

public sealed class ModelHitchException(string code, string message, string? providerId = null, int? statusCode = null) : Exception(message)
{
    public string Code { get; } = code;
    public string? ProviderId { get; } = providerId;
    public int? StatusCode { get; } = statusCode;
}