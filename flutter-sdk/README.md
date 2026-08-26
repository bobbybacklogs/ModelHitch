# ModelHitch for Dart and Flutter

The SDK is split so the provider-neutral protocol contract remains reusable outside Flutter:

| Package | Purpose |
| --- | --- |
| [`modelhitch_dart`](./modelhitch_dart) | Pure Dart client: types, providers, HTTP/SSE, errors, model discovery, and `KeyStore` contract |
| [`modelhitch_flutter`](./modelhitch_flutter) | Flutter adapter: re-exports the core and adds `FlutterSecureKeyStore` |

Neither package embeds Node.js, JavaScript, or the npm package. Use the Dart core from a server,
CLI, or another SDK extension; use the Flutter adapter for platform-backed end-user credentials.

Shared transport behavior is defined in the repository [conformance fixtures](../conformance).
Publish the core before publishing an adapter that depends on it.

See the [Dart README](./modelhitch_dart/README.md) and [Flutter README](./modelhitch_flutter/README.md)
for installation, security, bridge, and publishing details.