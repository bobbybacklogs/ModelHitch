# Releasing the ModelHitch Swift SDK (convention note)

Publishing requires Cass's explicit sign-off. This file documents the convention only.

## Versioning
- Semver (`MAJOR.MINOR.PATCH`). Pre-releases: `1.0.0-alpha.1`.
- Tag the release commit: `git tag swift-sdk-v1.0.0 && git push origin swift-sdk-v1.0.0`
- SPM consumes it as: `.package(url: "...", from: "1.0.0")` — the `swift-sdk-v` prefix is documentation; keep tags stable once pushed.

## Steps
1. Bump the version in the README/install snippet if one exists; open PR to `main`.
2. Tag the merge commit on `main` as `swift-sdk-v<version>` and push the tag.
3. Attach a source archive for manual inspection (optional):
   `swift package archive-source` (run in `swift-sdk/`) produces `ModelHitch.zip`.
4. Publish only after: CI green on the tag, `swift build`/`swift test` confirmed on an M1 (Haus gate), and Cass's sign-off.

## Not this repo's call
- Swift Package Index submission, CocoaPods, or any hosted distribution are separate decisions.
