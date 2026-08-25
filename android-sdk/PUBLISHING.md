# Publishing ModelHitch for Android

The Kotlin JAR and Android AAR publish through the Sonatype Central Portal under:

```text
io.github.bobbybacklogs.modelhitch:modelhitch-core
io.github.bobbybacklogs.modelhitch:modelhitch-android
```

Android versions and tags are independent of the npm package. Version `0.1.0` uses tag
`android-v0.1.0`.

## One-time Central setup

1. Sign in at <https://central.sonatype.com/> with the GitHub account that owns
   `bobbybacklogs/ModelHitch`.
2. Register and verify the `io.github.bobbybacklogs` namespace from the Central Portal Namespaces
   page. Do not publish until the namespace status is verified.
3. Generate a Central Portal user token. Save its generated username and password; these are not
   the interactive account credentials.
4. Install GnuPG and generate a signing key dedicated to releases:

   ```bash
   gpg --full-generate-key
   gpg --list-secret-keys --keyid-format=long
   gpg --keyserver keyserver.ubuntu.com --send-keys YOUR_KEY_ID
   gpg --export-secret-keys --armor YOUR_KEY_ID
   ```

5. Create a protected GitHub environment named `maven-central`, preferably with required reviewer
   approval, and add these environment secrets:

| Secret | Value |
| --- | --- |
| `MAVEN_CENTRAL_USERNAME` | Central Portal token username |
| `MAVEN_CENTRAL_PASSWORD` | Central Portal token password |
| `SIGNING_KEY` | Complete ASCII-armored private key, including BEGIN/END lines |
| `SIGNING_KEY_ID` | Long public key ID; optional but recommended |
| `SIGNING_PASSWORD` | Signing key passphrase |

Never put Central credentials, a private key, or its passphrase in `gradle.properties`, repository
files, command history, issues, or workflow logs.

## Release checklist

1. Update `modelhitch.version` in [`gradle.properties`](./gradle.properties).
2. Update Android dependency examples and release notes to that version.
3. Run the local release gate from the repository root:

   ```powershell
   $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
   .\android-sdk\gradlew.bat -p android-sdk `
     :modelhitch-core:test `
     :modelhitch-android:lintRelease `
     :modelhitch-android:assembleRelease `
     :sample-compose:lintDebug `
     :sample-compose:assembleDebug `
     :modelhitch-core:publishToMavenLocal `
     :modelhitch-android:publishToMavenLocal
   .\android-sdk\gradlew.bat -p android-sdk\consumer-smoke --refresh-dependencies assembleDebug
   ```

    The consumer smoke build is intentionally independent from the SDK Gradle project. It resolves
    only the published Maven coordinate and catches POM, AAR, transitive dependency, and Kotlin
    metadata compatibility regressions.

4. Commit and push the release changes.
5. Create and push an annotated Android tag matching the version:

   ```bash
   git tag -a android-v0.1.0 -m "ModelHitch Android 0.1.0"
   git push origin main
   git push origin android-v0.1.0
   ```

6. The `Publish Android SDK` workflow validates the tag, credentials, and signing inputs; runs tests,
   lint, release assembly, and local publication; then publishes and automatically releases both
   artifacts through Central Portal.
7. Verify both coordinates at <https://central.sonatype.com/> and then through Maven Central search.
   Portal release and public index propagation are not instantaneous.
8. Create a GitHub release for the `android-vX.Y.Z` tag with Android-specific release notes.

Central does not allow replacing an existing release coordinate. If publishing partially succeeds,
inspect the Central Portal deployment before changing the version or retrying.

## Manual preflight

The workflow passes secrets as Gradle project properties. To verify only the release contract
locally, provide the expected tag and the same properties through a private environment, then run:

```powershell
.\android-sdk\gradlew.bat -p android-sdk --no-configuration-cache validateCentralRelease `
   "-PreleaseTag=android-v0.1.0"
```

Without all credentials, `validateCentralRelease` is expected to fail and list only missing property
names. It never prints secret values.

## Version or namespace override

The checked-in defaults are:

```properties
modelhitch.group=io.github.bobbybacklogs.modelhitch
modelhitch.version=0.1.0
```

Both can be overridden with private Gradle project properties, but a different group must already
be verified in Central Portal and all public documentation must match before publishing.