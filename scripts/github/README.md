# GitHub task lifecycle scripts

PowerShell 7.6 scripts for routine, public-only GitHub task tracking.

- `github-task-lifecycle.ps1`: `Invoke-DurableGitHubTaskCreate` creates or adopts one Issue per task through an injected `-Transport` scriptblock (operations FIND, CREATE, READ).
- `sync-github-task-status.ps1`: `Invoke-DurableGitHubTaskStatusSync` updates the managed status region of a mapped Issue. It takes an optional `-Transport`; without one it uses the `gh` CLI for the existing status transport (READ and WRITE).

## Authorization and scope

The trusted caller supplies the authorization and acts as the single state writer. The scripts make no implicit external call and grant no READY, DONE, CAS, native broker or full Factory authority. Pass a transport only when the caller is authorized for the destination.

## Tests

Both harnesses need an independently reviewed candidate and source hash. They refuse to run otherwise, and they refuse an unsafe evidence root before writing or importing anything. The evidence root must be an absent directory named `software-factory-github-<32 lowercase hex>`, placed directly under the system temp path, with no symlink or reparse-point ancestor. The harness creates it; reuse is refused.

Use a fresh root for each run:

```powershell
$r = Join-Path ([IO.Path]::GetTempPath()) ('software-factory-github-' + [guid]::NewGuid().ToString('N'))
pwsh -File tests/github/github-task-lifecycle.tests.ps1 -CandidatePath scripts/github/github-task-lifecycle.ps1 -ExpectedSourceSha256 <reviewed-sha256> -EvidenceRoot $r

$r2 = Join-Path ([IO.Path]::GetTempPath()) ('software-factory-github-' + [guid]::NewGuid().ToString('N'))
pwsh -File tests/github/sync-github-task-status.tests.ps1 -EvidenceRoot $r2
```

Both harnesses compare the status adapter against its expected SHA-256 before importing it. Take the reviewed hash from an independent source. Do not compute it from the candidate and then treat it as reviewed.

The 103 lifecycle checks and 25 status checks must actually run under independent review. This README does not claim they have passed.
