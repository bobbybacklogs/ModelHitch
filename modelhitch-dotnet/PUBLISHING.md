# Publishing ModelHitch for .NET

The NuGet package is a standalone `net8.0` library. Its package version lives in
`src/ModelHitch/ModelHitch.csproj`; the initial release is `0.1.0`.

## First publication

1. Claim the `ModelHitch` package ID on NuGet.org, or select an available organization-qualified
   ID before publishing. NuGet package IDs cannot be transferred without the existing owner's approval.
2. Add the NuGet.org owner account or organization as a package owner after publication so releases
   do not depend on one personal account.
3. Create a NuGet.org API key scoped only to this package, with push permission. Store it in the
   publishing environment or CI secret; never commit it.
4. Build and run the conformance tests from this directory:

   ```powershell
   dotnet build src/ModelHitch/ModelHitch.csproj -c Release
   dotnet run --project tests/ModelHitch.Tests/ModelHitch.Tests.csproj -c Release
   dotnet pack src/ModelHitch/ModelHitch.csproj -c Release -o ./artifacts
   ```

5. Inspect `artifacts/ModelHitch.0.1.0.nupkg`, then publish it:

   ```powershell
   dotnet nuget push ./artifacts/ModelHitch.0.1.0.nupkg --api-key $env:NUGET_API_KEY --source https://api.nuget.org/v3/index.json
   ```

## Later releases

1. Update the package version, README, and changelog or release notes together.
2. Run the build, conformance executable, and pack command above.
3. Push the `.nupkg` with the API key or configure NuGet trusted publishing in repository CI.
4. Confirm the package page resolves, install it in a clean Windows application, and exercise the
   `mock/mock-model` bridge route before announcing the release.

NuGet versions are immutable. Never reuse a version, and use `--skip-duplicate` only in a CI retry
after confirming the already-published artifact is the intended one.