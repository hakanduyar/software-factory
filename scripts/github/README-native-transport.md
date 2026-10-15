# Native GitHub CLI transport (Windows, PowerShell 7.6)

Scope: `github-cli-transport216.ps1` provides a callable transport for the durable GitHub task lifecycle. It runs only a caller-supplied, hash-pinned `gh.exe` with bounded deadline, output caps and literal arguments. Windows with PowerShell 7.6 is the only supported platform.

## API

- `New-GitHubCliLifecycleTransport216 -GhPath <abs> -ExpectedGhSha256 <hex> -Repository hakanduyar/software-factory -TempRoot <abs dir> [-ProcessRunner <scriptblock>]` returns a transport scriptblock accepting `FIND`, `CREATE` and `READ` requests.
- `Invoke-GitHubCliBoundedProcess216` is the bounded native runner used by default.
- Paths must be canonical absolute paths without reparse points. The executable hash is re-checked before every start.

## Prerequisites (supplied by the trusted caller)

- `<gh.exe>`: canonical path to the genuine GitHub CLI, with its pinned SHA-256.
- `<csc.exe>`: canonical path to the pinned C# compiler, used only to build a harmless local fixture.
- `<temp-evidence-root>`: an absent direct child of the system temp directory named `software-factory-gh-native-<32 lowercase hex>`. The harness creates it and refuses existing, linked, nested or arbitrary roots.

## Check command

Run from the repository root:

```
pwsh -NoProfile -File tests/github/github-cli-transport216.tests.ps1 `
  -ProviderPath scripts/github/github-cli-transport216.ps1 `
  -ExpectedProviderSha256 68FE98B94572974E80F019CAFFF86E0CE74DA86072745C8F3F1A77A3C61847D7 `
  -GhPath <gh.exe> `
  -ExpectedGhSha256 E2EFA10A5D2CE93CAC9BC4B676932B62947C0967C01C8F2C3A9CB4437AD358D3 `
  -CompilerPath <csc.exe> `
  -ExpectedCompilerSha256 46809206887326D2D24DB1EFF1F3064DE972C3451ABE766B49111450A5E08E00 `
  -EvidenceRoot <temp-evidence-root> `
  -LifecyclePath scripts/github/github-task-lifecycle.ps1 `
  -ExpectedLifecycleSha256 218C964520D3D606D73B088095DBADF0C5071F11EB2699FE294FAFBBE928F780
```

The harness defines 88 cases and expects all to pass. This file does not claim that they have passed for any given candidate; run them.

## What the checks do and do not use

- The genuine `gh.exe` is only hashed and never started. No live GitHub call, authentication or model call is made.
- GitHub API outcomes are injected. The native runner is exercised with a harmless compiled local fixture.

## Authority

- The trusted caller authorizes use and is the single state writer.
- This transport grants no broker, CAS, READY, DONE or full-Factory acceptance, and no live delivery authority.
