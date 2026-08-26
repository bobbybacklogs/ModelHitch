# ModelHitch Conformance Fixtures

These versioned fixtures define the behavior shared by ModelHitch SDKs and extensions. They are
protocol contracts, not provider recordings: no fixture contains credentials or calls a live
service.

`openai-compatible-v1.json` is the initial OpenAI Chat Completions contract. SDK implementations
must preserve request model/message shape, normalize chat usage, concatenate SSE text deltas, and
defer the normalized finish event until any trailing usage frame has arrived.

Add a new fixture version when changing a cross-SDK wire contract. SDK-specific behavior belongs in
that SDK's test suite, not in this directory.