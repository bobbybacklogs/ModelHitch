# ModelHitch for Android

Native Kotlin access to ModelHitch's provider-neutral chat contract. The SDK uses coroutines,
OkHttp, Kotlin serialization, and Android Keystore. It does not run the npm package or bundle a
JavaScript engine.

## Modules

| Module | Artifact | Purpose |
| --- | --- | --- |
| `modelhitch-core` | `io.github.bobbybacklogs.modelhitch:modelhitch-core` | Pure Kotlin types, client, providers, errors, chat, and streaming |
| `modelhitch-android` | `io.github.bobbybacklogs.modelhitch:modelhitch-android` | Android AAR and Keystore-backed credential storage |
| `sample-compose` | Debug APK | Direct-BYOK Compose reference application |

The first external Android SDK release is version `0.1.0`. Until that release appears on Maven
Central, publish it locally while integrating or depend on the modules directly.

## Requirements

- Android `minSdk 23`
- Consumer `compileSdk 36` or later
- Kotlin 2.2 or later
- JDK 17 or later; the pinned Gradle wrapper runs correctly on JDK 21
- HTTPS provider endpoint, or an explicit app-owned network security policy for development HTTP

## Build

From the repository root on Windows:

```powershell
cd android-sdk
.\gradlew.bat :modelhitch-core:test
.\gradlew.bat :modelhitch-android:assembleRelease
.\gradlew.bat :sample-compose:assembleDebug
```

On macOS or Linux, use `./gradlew` instead.

Publish both SDK artifacts to Maven Local:

```powershell
.\gradlew.bat :modelhitch-core:publishToMavenLocal :modelhitch-android:publishToMavenLocal
```

Then consume the AAR from another Android project:

```kotlin
repositories {
    google()
    mavenCentral()
}

dependencies {
    implementation("io.github.bobbybacklogs.modelhitch:modelhitch-android:0.1.0")
}
```

Add `mavenLocal()` temporarily when consuming a locally published build.

## Direct BYOK

Use direct provider calls only for API keys supplied and owned by the device user. APK contents,
resources, BuildConfig fields, and native libraries cannot safely hold an application owner's
provider secret.

```kotlin
import com.genoventureslabs.modelhitch.ChatRequest
import com.genoventureslabs.modelhitch.DefaultProviders
import com.genoventureslabs.modelhitch.MessageContent
import com.genoventureslabs.modelhitch.ModelHitch
import com.genoventureslabs.modelhitch.ModelMessage
import com.genoventureslabs.modelhitch.StreamChunk
import com.genoventureslabs.modelhitch.android.AndroidKeyStoreCredentialStore

val keys = AndroidKeyStoreCredentialStore(applicationContext)
keys.set(selectedProviderId, keyEnteredByUser)

val hitch = ModelHitch(
    providers = DefaultProviders.all,
    keyStore = keys,
)

lifecycleScope.launch {
    hitch.stream(
        ChatRequest(
            provider = selectedProviderId,
            model = selectedModel,
            messages = listOf(
                ModelMessage.System(MessageContent.Text("Answer concisely.")),
                ModelMessage.User(MessageContent.Text(prompt)),
            ),
        ),
    ).collect { event ->
        when (event) {
            is StreamChunk.TextDelta -> appendText(event.text)
            is StreamChunk.ToolCallStart -> prepareTool(event.id, event.name)
            is StreamChunk.ToolCallArgumentsDelta -> appendToolArguments(event.id, event.argumentsDelta)
            is StreamChunk.ToolCallEnd -> executeTool(event.id)
            is StreamChunk.Finish -> showUsage(event.usage)
        }
    }
}
```

Cancel the collecting coroutine to cancel the underlying OkHttp call. Blocking response reads run
on `Dispatchers.IO`; streamed events resume in the collector's context.

Explicit `apiKey` or `baseUrl` values on `ChatRequest` take precedence over the configured
`KeyStore`, matching the TypeScript client.

## Built-in providers

`DefaultProviders` currently includes OpenAI, OpenRouter, Groq, Together AI, HuggingFace, Gemini's
OpenAI-compatible endpoint, DeepSeek, xAI, Mistral, Moonshot, and Z.ai. Each is an ordinary
`Provider`; pass a smaller list to `ModelHitch` when the app should expose only approved routes.

`ModelHitch()` uses `DefaultProviders.all` automatically. Provider IDs also namespace Keystore
entries, so saving an OpenAI key never overwrites an OpenRouter, Gemini, or Groq key.

Use `OpenAICompatibleProvider` and `OpenAICompatibleConfig` for another compatible gateway:

```kotlin
val provider = OpenAICompatibleProvider(
    OpenAICompatibleConfig(
        id = "company-gateway",
        name = "Company gateway",
        defaultModel = "default",
        baseUrl = "https://ai.example.com/v1",
        requiresKey = false,
    ),
)
```

The public `Provider` interface supports non-OpenAI protocols without changing application code.

## Compose sample

`sample-compose` is a runnable provider-neutral reference app. Its provider menu exposes every
built-in Android provider, loads that provider's default model, and stores a separate encrypted key
for each provider ID. The model remains editable because provider catalogs change independently of
SDK releases.

Build and install it with:

```powershell
.\gradlew.bat :sample-compose:assembleDebug
android install --apks=sample-compose\build\outputs\apk\debug\sample-compose-debug.apk
```

The sample intentionally makes live provider calls only after the user supplies a key. Automated
tests use MockWebServer and never contact a provider or require credentials.

## ModelHitch bridge

Application-owned keys belong on a backend or ModelHitch bridge:

```text
Android app -> HTTPS -> ModelHitch bridge -> provider
```

Point an `OpenAICompatibleProvider` at the bridge's `/v1` URL and set `requiresKey = false` unless
the bridge itself requires an authorization token. Routed model IDs such as
`vercel-ai-gateway/openai/gpt-5.4` pass through as the request model.

For local development:

- Android Emulator reaches the host machine at `10.0.2.2`, not `127.0.0.1`.
- A physical device must use the development machine's reachable LAN address.
- Cleartext `http://` is blocked by default. Add a debug-only network security configuration or use
  an HTTPS development endpoint; do not weaken the release manifest.

## Credential security

`AndroidKeyStoreCredentialStore` generates a non-exportable AES-256 key in `AndroidKeyStore`. Each
credential write uses a fresh GCM IV. The encrypted envelope is stored in private
`SharedPreferences`, and provider ID plus format version are authenticated as GCM associated data.
Keystore and disk operations run on `Dispatchers.IO`.

The encrypted preferences must not be restored onto another device because its Keystore key will
not exist there. The sample disables backup. Consumer applications that retain backup should
exclude `modelhitch_credentials_no_backup.xml` from both cloud backup and device transfer.

For Android 12 and later, add an exclusion to the app's data extraction rules:

```xml
<data-extraction-rules>
    <cloud-backup>
        <exclude domain="sharedpref" path="modelhitch_credentials_no_backup.xml" />
    </cloud-backup>
    <device-transfer>
        <exclude domain="sharedpref" path="modelhitch_credentials_no_backup.xml" />
    </device-transfer>
</data-extraction-rules>
```

Add the equivalent `sharedpref` exclusion to `fullBackupContent` rules for Android 11 and earlier.
When supplying a custom `preferencesName`, exclude `<preferencesName>.xml` instead.

Keystore protects key material at rest. A credential is necessarily plaintext in app memory while
making a provider request, so do not log headers, request bodies, raw exceptions, or API keys.

## Current scope

Implemented:

- Provider-neutral chat, multimodal content, tools, structured-output request types, and usage
- Coroutine `Flow` streaming with SSE fragmentation and tool-call accumulation
- Cancellation, typed HTTP/network errors, `Retry-After`, model listing, and credential precedence
- OpenAI-compatible providers and custom endpoints
- Android Keystore credential storage
- Provider-neutral Compose app with provider selection, per-provider secure keys, editable models,
  validation, streaming, errors, and cancellation

Not yet ported from TypeScript:

- Policy routing, automatic failover, circuit breaking, and catalog-backed dynamic providers
- Native Anthropic Messages and Gemini GenerateContent protocol adapters
- Usage persistence/dashboard and the automated multi-turn tool executor

Those features can be added behind the existing Kotlin `Provider`, `KeyStore`, and normalized event
contracts without changing application call sites.

## Publishing

Maintainers should follow [PUBLISHING.md](./PUBLISHING.md). Central releases are separate from npm
releases and use tags such as `android-v0.1.0`.