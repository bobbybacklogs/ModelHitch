using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Net.Http.Json;

namespace ModelHitch;

public sealed class OpenAICompatibleProvider : IModelProvider
{
    private readonly HttpClient httpClient;
    private readonly Uri baseUrl;
    private readonly bool requiresApiKey;
    private readonly string? apiKey;

    public OpenAICompatibleProvider(string id, string defaultModel, HttpClient httpClient, Uri baseUrl, bool requiresApiKey = true, string? apiKey = null)
    {
        Id = id;
        DefaultModel = defaultModel;
        this.httpClient = httpClient;
        this.baseUrl = NormalizeBaseUrl(baseUrl);
        this.requiresApiKey = requiresApiKey;
        this.apiKey = apiKey;
    }

    public string Id { get; }
    public string DefaultModel { get; }

    public async Task<ChatResult> ChatAsync(ChatParameters parameters, ProviderCredentials credentials, CancellationToken cancellationToken = default)
    {
        using var response = await SendAsync("chat/completions", parameters, credentials, stream: false, cancellationToken);
        using var document = JsonDocument.Parse(await response.Content.ReadAsStreamAsync(cancellationToken));
        var root = document.RootElement;
        var choice = root.GetProperty("choices")[0];
        var message = choice.GetProperty("message");
        return new ChatResult(
            ToAssistantMessage(message),
            choice.TryGetProperty("finish_reason", out var finish) ? finish.GetString() ?? "stop" : "stop",
            ToUsage(root),
            root.TryGetProperty("id", out var id) ? id.GetString() : null);
    }

    public async IAsyncEnumerable<StreamChunk> StreamAsync(ChatParameters parameters, ProviderCredentials credentials, [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        using var response = await SendAsync("chat/completions", parameters, credentials, stream: true, cancellationToken);
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var reader = new StreamReader(stream);
        var toolCallIds = new HashSet<string>(StringComparer.Ordinal);
        string finishReason = "stop";
        Usage? usage = null;
        string? responseId = null;

        while (await reader.ReadLineAsync(cancellationToken) is { } line)
        {
            if (!line.StartsWith("data:", StringComparison.Ordinal)) continue;
            var data = line[5..].Trim();
            if (data == "[DONE]") break;
            using var document = JsonDocument.Parse(data);
            var root = document.RootElement;
            responseId ??= root.TryGetProperty("id", out var id) ? id.GetString() : null;
            usage ??= ToUsage(root);
            if (!root.TryGetProperty("choices", out var choices) || choices.GetArrayLength() == 0) continue;
            var choice = choices[0];
            if (choice.TryGetProperty("finish_reason", out var reason) && reason.ValueKind != JsonValueKind.Null) finishReason = reason.GetString() ?? finishReason;
            if (!choice.TryGetProperty("delta", out var delta)) continue;
            if (delta.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.String) yield return new TextDelta(content.GetString()!);
            if (!delta.TryGetProperty("tool_calls", out var calls)) continue;
            foreach (var call in calls.EnumerateArray())
            {
                var callId = call.TryGetProperty("id", out var callIdValue) ? callIdValue.GetString() : null;
                var index = call.TryGetProperty("index", out var indexValue) ? indexValue.GetInt32().ToString() : "0";
                var key = callId ?? index;
                if (callId is not null && toolCallIds.Add(callId))
                {
                    var name = call.TryGetProperty("function", out var function) && function.TryGetProperty("name", out var nameValue) ? nameValue.GetString() ?? "unknown" : "unknown";
                    yield return new ToolCallStart(callId, name);
                }
                if (call.TryGetProperty("function", out var functionData) && functionData.TryGetProperty("arguments", out var arguments) && arguments.ValueKind == JsonValueKind.String)
                    yield return new ToolCallArgumentsDelta(key, arguments.GetString()!);
            }
        }

        foreach (var toolCallId in toolCallIds) yield return new ToolCallEnd(toolCallId);
        yield return new Finish(finishReason, usage, responseId);
    }

    public async Task<IReadOnlyList<ModelInfo>> ListModelsAsync(ProviderCredentials credentials, CancellationToken cancellationToken = default)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(credentials.BaseUrl ?? baseUrl, "models"));
        ApplyAuthorization(request, credentials);
        using var response = await httpClient.SendAsync(request, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        using var document = JsonDocument.Parse(await response.Content.ReadAsStreamAsync(cancellationToken));
        return document.RootElement.GetProperty("data").EnumerateArray().Select(model => new ModelInfo(model.GetProperty("id").GetString()!)).ToArray();
    }

    private async Task<HttpResponseMessage> SendAsync(string path, ChatParameters parameters, ProviderCredentials credentials, bool stream, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(credentials.BaseUrl ?? baseUrl, path));
        ApplyAuthorization(request, credentials);
        request.Content = JsonContent.Create(ToRequestBody(parameters, stream));
        var response = await httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        return response;
    }

    private void ApplyAuthorization(HttpRequestMessage request, ProviderCredentials credentials)
    {
        var key = credentials.ApiKey ?? apiKey;
        if (requiresApiKey && string.IsNullOrWhiteSpace(key)) throw new ModelHitchException("missing-api-key", $"Provider '{Id}' requires an API key.", Id);
        if (!string.IsNullOrWhiteSpace(key)) request.Headers.Authorization = new("Bearer", key);
    }

    private async Task EnsureSuccessAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        if (response.IsSuccessStatusCode) return;
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        throw new ModelHitchException(response.StatusCode == System.Net.HttpStatusCode.Unauthorized ? "invalid-api-key" : "provider-error", $"Provider '{Id}' returned HTTP {(int)response.StatusCode}: {body}", Id, (int)response.StatusCode);
    }

    private static object ToRequestBody(ChatParameters parameters, bool stream) => new
    {
        model = parameters.Model,
        messages = parameters.Messages.Select(message => new
        {
            role = message.Role,
            content = message.Content,
            name = message.Name,
            tool_call_id = message.ToolCallId,
            tool_calls = message.ToolCalls?.Select(call => new { id = call.Id, type = "function", function = new { name = call.Name, arguments = call.Arguments.GetRawText() } })
        }),
        tools = parameters.Tools?.Select(tool => new { type = "function", function = new { name = tool.Name, description = tool.Description, parameters = tool.Parameters } }),
        temperature = parameters.Temperature,
        max_tokens = parameters.MaxTokens,
        stop = parameters.Stop,
        tool_choice = parameters.ToolChoice,
        stream,
        stream_options = stream ? new { include_usage = true } : null,
    };

    private static ModelMessage ToAssistantMessage(JsonElement message)
    {
        var content = message.TryGetProperty("content", out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? string.Empty : string.Empty;
        var calls = message.TryGetProperty("tool_calls", out var rawCalls)
            ? rawCalls.EnumerateArray().Select((call, index) => new ToolCall(
                call.TryGetProperty("id", out var id) ? id.GetString() ?? $"call_{index}" : $"call_{index}",
                call.GetProperty("function").GetProperty("name").GetString() ?? "unknown",
                JsonDocument.Parse(call.GetProperty("function").GetProperty("arguments").GetString() ?? "{}").RootElement.Clone())).ToArray()
            : null;
        return ModelMessage.Assistant(content, calls);
    }

    private static Usage? ToUsage(JsonElement root)
    {
        if (!root.TryGetProperty("usage", out var usage) || usage.ValueKind == JsonValueKind.Null) return null;
        return new Usage(
            usage.TryGetProperty("prompt_tokens", out var input) ? input.GetInt32() : null,
            usage.TryGetProperty("completion_tokens", out var output) ? output.GetInt32() : null,
            usage.TryGetProperty("total_tokens", out var total) ? total.GetInt32() : null);
    }

    private static Uri NormalizeBaseUrl(Uri url) => url.AbsoluteUri.EndsWith('/') ? url : new Uri(url.AbsoluteUri + "/");
}