# ModelHitch for Flutter

Provider-neutral BYOK chat, streaming, tools, model discovery, and encrypted credential storage
for Flutter apps. This package re-exports `modelhitch_dart` and adds Flutter's encrypted platform
credential storage; the core package owns the OpenAI-compatible HTTP and SSE implementation.

## Install

```bash
flutter pub add modelhitch_flutter
```

Or add the dependency manually:

```yaml
dependencies:
  modelhitch_flutter: ^0.1.0
```

## Direct BYOK

Only store a key supplied and owned by the device user. An application-owned provider key cannot
be kept secret inside a mobile application; use a backend or ModelHitch bridge for that case.

```dart
import 'package:modelhitch_flutter/modelhitch_flutter.dart';

final keys = FlutterSecureKeyStore();
await keys.set('openai', keyEnteredByUser);

final hitch = ModelHitch(keyStore: keys);
final subscription = hitch.stream(
  ChatRequest(
    provider: 'openai',
    model: 'gpt-4o-mini',
    messages: [
      ModelMessage.system(MessageContent.text('Answer concisely.')),
      ModelMessage.user(MessageContent.text(prompt)),
    ],
  ),
).listen((chunk) {
  switch (chunk) {
    case TextDelta(:final text):
      appendText(text);
    case ToolCallStart(:final id, :final name):
      prepareTool(id, name);
    case ToolCallArgumentsDelta(:final id, :final argumentsDelta):
      appendToolArguments(id, argumentsDelta);
    case ToolCallEnd(:final id):
      executeTool(id);
    case Finish(:final usage):
      showUsage(usage);
  }
});

// Cancels the pending HTTP request and stream subscription.
await subscription.cancel();
```

`FlutterSecureKeyStore` is backed by `flutter_secure_storage`, which uses encrypted platform
credential storage. It namespaces values by provider ID, so a key for OpenAI does not overwrite an
OpenRouter, Gemini, or Groq key. Use `MemoryKeyStore` for tests or ephemeral sessions.

Explicit `apiKey` or `baseUrl` values on `ChatRequest` take precedence over the configured
`KeyStore`.

## Built-in providers

`DefaultProviders.all` contains OpenAI, OpenRouter, Groq, Together AI, Hugging Face, Gemini's
OpenAI-compatible endpoint, DeepSeek, xAI, Mistral AI, Moonshot AI, and Z.ai. Each is an ordinary
`Provider`, so apps can expose only approved routes:

```dart
final hitch = ModelHitch(
  providers: [
    DefaultProviders.all.singleWhere((provider) => provider.id == 'openai'),
  ],
  keyStore: FlutterSecureKeyStore(),
);
```

Use `OpenAICompatibleProvider` for an approved gateway or another compatible provider:

```dart
final bridge = OpenAICompatibleProvider(
  const OpenAICompatibleConfig(
    id: 'company-bridge',
    name: 'Company bridge',
    defaultModel: 'vercel-ai-gateway/openai/gpt-5.4',
    baseUrl: 'https://ai.example.com/v1',
    requiresKey: false,
  ),
);
```

## ModelHitch bridge

Keep application-owned provider keys on a trusted service:

```text
Flutter app -> HTTPS -> ModelHitch bridge -> provider
```

Set the bridge's `/v1` URL as an `OpenAICompatibleConfig.baseUrl`. Routed model IDs such as
`vercel-ai-gateway/openai/gpt-5.4` pass through as the request model. Set `requiresKey: false` only when
the bridge does not itself require client authorization.

For local Android development, an emulator reaches the host machine at `10.0.2.2`, not
`127.0.0.1`. A physical device needs a reachable LAN address or HTTPS development endpoint. Do not
allow cleartext HTTP in release builds.

## Platform setup

`flutter_secure_storage` has platform integration requirements that can change with its release.
Follow its current setup guide for Android/iOS/Linux/macOS/Windows/Web, including Android backup
exclusions and iOS Keychain configuration where applicable. API keys are necessarily plaintext in
process memory during provider calls: never log request headers, request bodies, raw errors, or
keys.

## Error handling

Failures are `ModelHitchException` values with a stable `ModelHitchErrorCode`; do not parse a
provider's message text.

```dart
try {
  await hitch.chat(request);
} on ModelHitchException catch (error) {
  if (error.code == ModelHitchErrorCode.rateLimited) {
    scheduleRetry(error.retryAfter);
  }
}
```

## Development

```bash
cd flutter-sdk/modelhitch_flutter
flutter pub get
dart format --set-exit-if-changed .
flutter analyze
flutter test
```

Run the core package checks before this adapter's checks:

```bash
cd ../modelhitch_dart
dart pub get
dart format --set-exit-if-changed .
dart analyze
dart test
```

The core tests use a loopback `HttpServer`; they never contact a live provider or require
credentials. The Flutter test verifies that the secure-storage adapter implements the public core
credential contract.

## Publishing

Flutter/Pub releases are independent from npm and Maven releases. Before publishing a new version:

1. Publish the required `modelhitch_dart` version first.
2. Update `version` and the `modelhitch_dart` dependency range in `pubspec.yaml`.
3. Run the development checks above and `dart pub publish --dry-run`.
4. Commit and push the release changes, then tag the release as `flutter-vX.Y.Z`.
5. For the first release, publish interactively and transfer the package to the verified publisher.
  Pub.dev only exposes GitHub Actions automated-publishing setup after a package exists.
6. On the package Admin tab, configure repository `genoventures-labs/ModelHitch`, tag pattern
  `flutter-v{{version}}`, and required GitHub Actions environment `pub-dev`.
7. Verify the package and dependency resolution on pub.dev.

Do not publish credentials or tokenized release output.