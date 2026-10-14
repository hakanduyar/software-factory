# Refill planner (pure)

`refill-planner.ps1` defines `Get-ContinuityRefillProposal175`, a pure function that turns a backlog snapshot plus controller-supplied facts into a **proposal** of tasks that could be started next.

## Requirements

- PowerShell 5.1 or PowerShell 7+ (Windows paths are the supported path format for owned-path facts).
- `backlog-dependency-projection.ps1` must sit next to `refill-planner.ps1`. The planner locates it via `$PSScriptRoot`, verifies its SHA-256 (`1DFAC70A2EA2E2F584EF01393F461C901D4950FE9F2C02CE14831C9CD7FD1F5D`) and refuses to load on a missing or changed file (`REFILL_DEPENDENCY_PIN_MISSING`, `REFILL_DEPENDENCY_PIN_MISMATCH`).

## Usage

```powershell
. ./scripts/planning/refill-planner.ps1
$proposal = Get-ContinuityRefillProposal175 -BacklogSnapshot $snapshot -ControllerFacts $facts
```

Inputs follow the `BacklogDependencyProjectionInput/v1` and `RefillPlannerFacts/v1` shapes. Malformed input fails closed with a specific error; nothing is guessed.

## Scope and authority limits

- Pure computation: no file, network, process or Git access beyond loading the pinned sibling dependency; inputs are not mutated.
- The result has `grantsAuthority = $false`. It is a proposal only. It does not perform compare-and-swap, mark work READY, dispatch workers, or act as a complete Factory. Any such step requires a separate controller and its own gates.
- Paused facts always yield zero proposed candidates.

## Tests and the reviewed digest

The tests refuse to import the planner unless its SHA-256 equals a digest you pass explicitly. That digest is the one frozen by the independent review of the exact planner file; the test never embeds it, so an unreviewed edit cannot pass silently.

```powershell
$digest = (Get-FileHash ./scripts/planning/refill-planner.ps1 -Algorithm SHA256).Hash  # only to inspect; use the reviewed value for gating
$evidence = Join-Path ([System.IO.Path]::GetTempPath()) ('software-factory-refill-' + [guid]::NewGuid().ToString('N'))
pwsh -File ./tests/planning/refill-planner.tests.ps1 `
  -PlannerPath ./scripts/planning/refill-planner.ps1 `
  -ExpectedPlannerSha256 <reviewed-sha256> `
  -EvidenceRoot $evidence
```

`-EvidenceRoot` must be a canonical, not-yet-existing directory named `software-factory-refill-<32 lowercase hex>` directly under the system temp path, with no reparse-point ancestors. The test creates only that directory (including owned fixture copies used for the missing/changed-dependency refusal checks) and writes `receipt.json` there. Exit code is 0 only if every check passes.
