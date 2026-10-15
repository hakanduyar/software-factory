# PlannerTask leaf (refill-planner-task266)

A pure, lexical PowerShell validator for one PlannerTask object. It is scoped to Windows and PowerShell 7. The harness requires a canonical `C:\` source path, so cross-platform use is not claimed.

## Contract

`AssertRefillPlannerTask266 -Value <object>` returns exactly one `$true`. Otherwise it throws `REFILL266_INVALID:<CATEGORY>`. The categories are SHAPE, TYPE, ID, UNICODE, PATH, CAP, DUPLICATE and ELIGIBILITY.

The value must be a `PSCustomObject` with exactly three `NoteProperty` fields. Names are case-sensitive.

- `taskId`: a string, 1 to 128 UTF-16 units, not whitespace-only, with no lone surrogates.
- `eligibility`: one of `VERIFIED_ELIGIBLE`, `INELIGIBLE` or `UNKNOWN`. These are labels only. They are not verified authority.
- `ownedCanonicalPaths`: an `object[]` of 1 to 64 strings. Each is a canonical absolute Windows drive path such as `C:\dir\file`. Duplicates are compared case-insensitively.

Metadata is checked before any value is read. A `ScriptProperty` or any other non-`NoteProperty` member is refused without running its getter.

## Limits

Path validation is lexical only. It does not prove that a path exists, that it is free of reparse points, that it is sandboxed, that anyone effectively owns it, or that anyone is authorized. This leaf grants no codec, Options264, gateway, runtime queue, planner dispatch, integration, live provider or full Factory authority.

## Usage

```powershell
. <checkout>\scripts\planning\refill-planner-task266.ps1
$task = [pscustomobject]@{
    taskId = 'T1'
    eligibility = 'UNKNOWN'
    ownedCanonicalPaths = [object[]]@('C:\work\one')
}
AssertRefillPlannerTask266 -Value $task
```

## Public harness

The harness takes a canonical `C:\` source path and a full external SHA-256 pin. It also takes an absent evidence root, which must be a direct child of the system temp directory named `software-factory-refill-<32 lowercase hex>`. The harness creates that root itself.

```powershell
pwsh -NoProfile -File <checkout>\tests\planning\refill-planner-task266.tests.ps1 `
  -CandidatePath <checkout>\scripts\planning\refill-planner-task266.ps1 `
  -ExpectedSourceSha256 d75f4912b8395f4e6e4221e3989dceffa86bd9737a4ae5e89b85bedbe052f840 `
  -EvidenceRoot <system-temp>\software-factory-refill-<32-lowercase-hex> `
  -Group ALL
```

`-Group ALL` is required for acceptance. It runs 66 checks in four non-empty groups: VALID 5, METADATA 11, TYPES 26 and PATHS 24. A receipt is written under the evidence root.

## Status

The public checks for this packaged candidate are NOT_RUN. Nothing here claims validation from private history.
