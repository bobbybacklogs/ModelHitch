# Publishing Dart and Flutter SDKs

The Dart core and Flutter adapter are independent Pub packages:

```text
modelhitch_dart
modelhitch_flutter -> modelhitch_dart
```

Both packages must first be published interactively, then transferred to the intended ModelHitch
publisher. Pub.dev only permits GitHub Actions automated publishing for an existing package. Use
one confirmed organization identity for the package publisher, repository metadata, and release
approvals.

## Trusted publishing setup

For each already-published package, configure Pub.dev automated publishing to permit this GitHub
repository and its matching tag workflow. Protect the `pub-dev` GitHub environment and require
review before it can issue the workflow's OIDC token. Do not place a long-lived Pub access token in
repository secrets.

The workflows are:

| Package | Tag | Workflow |
| --- | --- | --- |
| Dart core | `dart-vX.Y.Z` | `Publish Dart SDK` |
| Flutter adapter | `flutter-vX.Y.Z` | `Publish Flutter SDK` |

## Initial publication

1. Sign in to Pub.dev with the Google Account that will be an admin of the verified publisher.
2. From `modelhitch_dart`, run the validation commands and the interactive `dart pub publish`.
3. Open `https://pub.dev/packages/modelhitch_dart/admin`, select **Transfer to Publisher**, and
	select the verified ModelHitch publisher.
4. On that package's **Admin** tab, enable publishing from GitHub Actions with repository
	`genoventures-labs/ModelHitch` and tag pattern `dart-v{{version}}`.
5. On that same page, require the GitHub Actions environment named `pub-dev`; create and protect
	the identically named GitHub repository environment if it does not already exist.
6. Publish `modelhitch_flutter` interactively only after the core version is available on Pub.dev.
7. Transfer `modelhitch_flutter` to the same publisher and enable GitHub Actions with repository
	`genoventures-labs/ModelHitch`, tag pattern `flutter-v{{version}}`, and environment `pub-dev`.

## Later releases

1. Update the core version, changelog, documentation, and example.
2. From `modelhitch_dart`, run `dart pub get`, format, analyze, test, and `dart pub publish --dry-run`.
3. Push an annotated `dart-vX.Y.Z` tag. Confirm the Pub release is available.
4. Update the Flutter adapter's core dependency constraint and changelog.
5. From `modelhitch_flutter`, run `flutter pub get`, format, analyze, test, and `dart pub publish --dry-run`.
6. Push an annotated `flutter-vX.Y.Z` tag. Confirm the adapter resolves against the released core.

Never tag a release whose package version does not exactly match the tag. Pub does not allow an
existing version to be replaced.