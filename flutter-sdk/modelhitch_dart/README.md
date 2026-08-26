# ModelHitch for Dart

`modelhitch_dart` is the platform-neutral ModelHitch client. It supplies normalized chat types,
OpenAI-compatible providers, HTTP/SSE streaming, model discovery, typed errors, and credential
storage interfaces for Dart servers, CLIs, Flutter apps, and extension packages.

For encrypted mobile credential storage, depend on `modelhitch_flutter`, which re-exports this
package and adds `FlutterSecureKeyStore`.

## Install

```bash
dart pub add modelhitch_dart
```

## Usage

```dart
import 'package:modelhitch_dart/modelhitch_dart.dart';

final hitch = ModelHitch(keyStore: MemoryKeyStore());
await hitch.keyStore?.set('openai', userProvidedKey);

await for (final chunk in hitch.stream(
  ChatRequest(
    provider: 'openai',
    model: 'gpt-4o-mini',
    messages: [ModelMessage.user(MessageContent.text('Hello'))],
  ),
)) {
  if (chunk case TextDelta(:final text)) print(text);
}
```

Use direct BYOK only with a key supplied and owned by the current user. Application-owned provider
credentials belong behind a trusted backend or ModelHitch bridge.

## Extension contract

External extensions compose at two stable boundaries:

- Implement `Provider` for a new AI wire protocol.
- Implement `KeyStore` for a new credential storage mechanism.

Providers receive normalized `ChatParams` and emit a `ChatResult` or `Stream<StreamChunk>`. Errors
must be `ModelHitchException` with a stable `ModelHitchErrorCode`; do not expose provider-specific
error parsing to callers. Cross-SDK OpenAI-compatible behavior is defined by the repository's
[`conformance`](../../conformance) fixtures.

## Development

```bash
dart pub get
dart format --set-exit-if-changed .
dart analyze
dart test
dart pub publish --dry-run
```

Releases use independent `dart-vX.Y.Z` tags. Publish `modelhitch_dart` before any adapter package
that depends on it.