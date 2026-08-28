using System.Net;
using System.Text;
using ModelHitch;

var tests = new (string Name, Func<Task> Run)[]
{
    ("chat maps request and response", ChatMapsRequestAndResponse),
    ("stream retains trailing usage", StreamRetainsTrailingUsage),
};

var failures = new List<string>();
foreach (var test in tests)
{
    try { await test.Run(); Console.WriteLine($"PASS {test.Name}"); }
    catch (Exception exception) { failures.Add($"FAIL {test.Name}: {exception.Message}"); }
}

if (failures.Count > 0)
{
    Console.Error.WriteLine(string.Join(Environment.NewLine, failures));
    return 1;
}

return 0;

static async Task ChatMapsRequestAndResponse()
{
    var handler = new StubHandler(async request =>
    {
        Assert(request.RequestUri!.AbsolutePath == "/v1/chat/completions", "chat endpoint");
        var body = await request.Content!.ReadAsStringAsync();
        Assert(body.Contains("\"model\":\"test-model\"", StringComparison.Ordinal), "model serialized");
        return Json("""{"id":"chat_1","choices":[{"message":{"role":"assistant","content":"Hello ModelHitch"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}""");
    });
    var hitch = ModelHitchClient.ForBridge(new HttpClient(handler), new Uri("http://localhost:3939/v1"), "test-model");
    var result = await hitch.ChatAsync(new ChatRequest([ModelMessage.User("Hello")]));
    Assert(result.Message.Content == "Hello ModelHitch", "assistant text");
    Assert(result.Usage?.TotalTokens == 5, "usage mapped");
}

static async Task StreamRetainsTrailingUsage()
{
    var sse = "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"},\"finish_reason\":null}]}\n\n" +
              "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"},\"finish_reason\":\"stop\"}]}\n\n" +
              "data: {\"choices\":[],\"usage\":{\"total_tokens\":7}}\n\n" +
              "data: [DONE]\n\n";
    var hitch = ModelHitchClient.ForBridge(new HttpClient(new StubHandler(_ => Task.FromResult(Sse(sse)))), new Uri("http://localhost:3939/v1"), "test-model");
    var events = new List<StreamChunk>();
    await foreach (var item in hitch.StreamAsync(new ChatRequest([ModelMessage.User("Hello")]))) events.Add(item);
    Assert(string.Concat(events.OfType<TextDelta>().Select(chunk => chunk.Text)) == "Hello", "deltas concatenated");
    Assert(events.OfType<Finish>().Single().Usage?.TotalTokens == 7, "trailing usage retained");
}

static HttpResponseMessage Json(string body) => new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
static HttpResponseMessage Sse(string body) => new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "text/event-stream") };
static void Assert(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }

sealed class StubHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> response) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => response(request);
}