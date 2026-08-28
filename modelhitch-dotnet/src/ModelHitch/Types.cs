using System.Text.Json;

namespace ModelHitch;

public sealed record ProviderCredentials(string? ApiKey = null, Uri? BaseUrl = null);

public sealed record ToolDefinition(string Name, string? Description = null, JsonElement? Parameters = null);

public sealed record ToolCall(string Id, string Name, JsonElement Arguments);

public sealed record ModelMessage(
    string Role,
    string Content,
    string? Name = null,
    IReadOnlyList<ToolCall>? ToolCalls = null,
    string? ToolCallId = null)
{
    public static ModelMessage System(string content, string? name = null) => new("system", content, name);
    public static ModelMessage User(string content, string? name = null) => new("user", content, name);
    public static ModelMessage Assistant(string content, IReadOnlyList<ToolCall>? toolCalls = null) => new("assistant", content, ToolCalls: toolCalls);
    public static ModelMessage Tool(string content, string toolCallId) => new("tool", content, ToolCallId: toolCallId);
}

public sealed record ChatRequest(
    IReadOnlyList<ModelMessage> Messages,
    string? Provider = null,
    string? Model = null,
    string? ApiKey = null,
    Uri? BaseUrl = null,
    IReadOnlyList<ToolDefinition>? Tools = null,
    double? Temperature = null,
    int? MaxTokens = null,
    IReadOnlyList<string>? Stop = null,
    string? ToolChoice = null);

public sealed record ChatParameters(
    string Model,
    IReadOnlyList<ModelMessage> Messages,
    IReadOnlyList<ToolDefinition>? Tools = null,
    double? Temperature = null,
    int? MaxTokens = null,
    IReadOnlyList<string>? Stop = null,
    string? ToolChoice = null);

public sealed record Usage(int? InputTokens = null, int? OutputTokens = null, int? TotalTokens = null);

public sealed record ChatResult(
    ModelMessage Message,
    string FinishReason,
    Usage? Usage = null,
    string? ResponseId = null);

public abstract record StreamChunk;
public sealed record TextDelta(string Text) : StreamChunk;
public sealed record ToolCallStart(string Id, string Name) : StreamChunk;
public sealed record ToolCallArgumentsDelta(string Id, string ArgumentsDelta) : StreamChunk;
public sealed record ToolCallEnd(string Id) : StreamChunk;
public sealed record Finish(string FinishReason, Usage? Usage = null, string? ResponseId = null) : StreamChunk;

public sealed record ModelInfo(string Id, string? Name = null, int? ContextLength = null);

public interface IModelProvider
{
    string Id { get; }
    string DefaultModel { get; }
    Task<ChatResult> ChatAsync(ChatParameters parameters, ProviderCredentials credentials, CancellationToken cancellationToken = default);
    IAsyncEnumerable<StreamChunk> StreamAsync(ChatParameters parameters, ProviderCredentials credentials, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<ModelInfo>> ListModelsAsync(ProviderCredentials credentials, CancellationToken cancellationToken = default);
}