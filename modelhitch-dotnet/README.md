# ModelHitch for .NET

`ModelHitch` is a provider-neutral, bring-your-own-key chat client for modern .NET applications.
It is a pure `net8.0` library: it does not bundle Node.js or JavaScript. Use it directly with an
OpenAI-compatible provider, or use `ForBridge` to connect a Windows app to the local ModelHitch bridge.

## Install

```powershell
dotnet add package ModelHitch
```

## Connect to the local bridge

Start the bridge separately, for example with `modelhitch bridge --background`. The bridge keeps
provider keys on the machine and exposes an OpenAI-compatible endpoint at `http://127.0.0.1:3939/v1`.

```csharp
using ModelHitch;

using var httpClient = new HttpClient();
var hitch = ModelHitchClient.ForBridge(
    httpClient,
    new Uri("http://127.0.0.1:3939/v1"),
    "mock/mock-model");

var reply = await hitch.ChatAsync(new ChatRequest([
    ModelMessage.System("Answer concisely."),
    ModelMessage.User("Hello from a Windows app."),
]));

Console.WriteLine(reply.Message.Content);
```

For production, reuse one `HttpClient` for the application lifetime. Do not package an
application-owned provider key in a Windows binary; connect to a trusted backend or the local bridge.

## Direct OpenAI-compatible provider

```csharp
var provider = new OpenAICompatibleProvider(
    id: "openai",
    defaultModel: "gpt-5.2",
    httpClient: httpClient,
    baseUrl: new Uri("https://api.openai.com/v1"),
    apiKey: userSuppliedKey);
var hitch = new ModelHitchClient([provider], defaultProviderId: "openai");
```

`ChatAsync` returns a completed response. `StreamAsync` exposes `TextDelta`, tool-call events, and a
final `Finish` event that includes trailing streamed usage when the provider sends it.

## Development and publishing

From `modelhitch-dotnet`:

```powershell
dotnet build src/ModelHitch/ModelHitch.csproj -c Release
dotnet run --project tests/ModelHitch.Tests/ModelHitch.Tests.csproj -c Release
dotnet pack src/ModelHitch/ModelHitch.csproj -c Release -o ./artifacts
```

Use a NuGet.org API key supplied through the command environment; never commit it:

```powershell
dotnet nuget push ./artifacts/ModelHitch.0.1.0.nupkg --api-key $env:NUGET_API_KEY --source https://api.nuget.org/v3/index.json
```