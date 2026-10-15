# TaskFact validator (Windows PowerShell)

`scripts/planning/refill-task-fact271.ps1` is a definitions-only module. It does no IO, imports nothing, keeps no state and takes no native actions. Dot-source it, then call `AssertRefillTaskFact271 -Value $fact`. On success it returns exactly one `$true`. On failure it throws `REFILL271_INVALID:<CATEGORY>`, where the category is one of SHAPE, TYPE, ID, UNICODE, PATH, CAP, DUPLICATE or ELIGIBILITY.

Scope: Windows with `C:` drive paths only. This makes no cross-platform claim and grants no physical filesystem ownership.

## Fields

The value must be a PSCustomObject with exactly four case-sensitive NoteProperty fields. They are checked before any value is read, and no getter is ever invoked (ScriptProperty is refused as SHAPE).

- `taskId`: string, non-blank, at most 128 UTF-16 units, no unpaired surrogates.
- `ownedCanonicalPaths`: `object[]` of 1 to 64 canonical Windows drive paths, unique ignoring case.
- `eligibility`: one of `VERIFIED_ELIGIBLE`, `INELIGIBLE`, `UNKNOWN` (case-sensitive).
- `eligibilityEvidenceRef`: a canonical Windows drive path string.

```powershell
. <local-absolute-path>\scripts\planning\refill-task-fact271.ps1
$fact = [pscustomobject]@{
  taskId = 'T1'
  ownedCanonicalPaths = [object[]]@('C:\work\one')
  eligibility = 'UNKNOWN'
  eligibilityEvidenceRef = 'C:\evidence\e1'
}
AssertRefillTaskFact271 -Value $fact
```

## Limitation

`eligibilityEvidenceRef` is checked lexically only, as a primitive canonical path string. A passing value proves nothing about whether the evidence exists, its hash, its freshness, or any eligibility authority. The path need not exist.

## Public check (ALL)

The harness is parameterized. It requires a canonical `C:` source path with an independent expected SHA-256. The evidence root must be absent, canonical, and a direct child of the system temp directory named `software-factory-refill-<32 lowercase hex>`.

```powershell
pwsh -NoProfile -File <local-absolute-path>\tests\planning\refill-task-fact271.tests.ps1 `
  -CandidatePath <local-absolute-C-path>\scripts\planning\refill-task-fact271.ps1 `
  -ExpectedSourceSha256 c732e439f6034aa9319821f53a7018782e5357c9813877e96acc92a5fd01e9ba `
  -EvidenceRoot <system-temp>\software-factory-refill-<32-lowercase-hex> `
  -Group ALL
```

The expected result is 39 checks in four non-empty groups: VALID 6, METADATA 12, EVIDENCE 10, SHARED 11.

## Reuse basis

The shared helpers (failure, Unicode and path-category) have been normalized-AST compared with the accepted Planner source D75F. That is a verification-reuse basis bound to the fingerprints of the accepted source review and the published Planner evidence. It is not a runtime dependency and adds no new checks. The 39 checks are not 105, and the 66 Planner checks are not rerun here.

## Status

The new public candidate checks are NOT_RUN. Earlier private history does not prove a public pass. No codec, gateway, queue, READY/DONE, replay, budget or full-Factory authority is claimed.
