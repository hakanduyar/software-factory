# Binding and eligibility evidence record validators

Two dot-source-only PowerShell validators with definitions only and no IO. They check record syntax, types, metadata and lexical Windows paths. They do not prove that any evidence exists, its hash, freshness, ownership, provider eligibility, or any current authority.

## Exports

### `AssertRefillBinding306` (`scripts/planning/refill-binding306.ps1`)

Takes a `PSCustomObject` with exactly nine case-sensitive NoteProperties. All metadata is checked before any value is read, so property getters are never run. Returns `$true` or throws a fixed `REFILL306_INVALID:<category>` error.

- `planPath`, `receiptPath`, `eligibilityEvidenceRef`: strings that are lexical canonical Windows paths (`C:\` root allowed).
- `planSha256`, `receiptSha256`: strings of exactly 64 lowercase hex characters.
- `provider`: string, ordinal `independent` or `claude`.
- `owner`, `taskId`: non-blank strings, 1..128 chars, well-formed Unicode.
- `enabled`: primitive boolean.

No actual hash is computed and no file is read.

### `AssertRefillEligibilityEvidence311` (`scripts/planning/refill-eligibility-evidence311.ps1`)

Takes a `PSCustomObject` with exactly six case-sensitive NoteProperties, checked the same way. Throws `REFILL311_INVALID:<category>` on failure.

- `ownedCanonicalPaths`: `object[]` of 1..64 lexical canonical Windows paths, unique under OrdinalIgnoreCase.
- `classification`: exactly `NONMODEL_SYNTHETIC_FIXTURE`.
- `schema`: exactly `IsolatedEligibilityEvidence249/v1`.
- `eligibility`: one of the labels `VERIFIED_ELIGIBLE`, `INELIGIBLE`, `UNKNOWN`.
- `owner`, `taskId`: non-blank strings, 1..128 chars, well-formed Unicode.

`VERIFIED_ELIGIBLE` is a synthetic fixture label only. It is never real eligibility or evidence approval.

## Windows usage

The harnesses are scoped to Windows with a `C:` checkout. No Linux support is claimed. `-CandidatePath` must be a canonical absolute `C:` path with single backslash separators. It is checked ordinally, must not be a reparse point, and must match the externally supplied full SHA-256 pin. `-EvidenceRoot` must be a fresh, absent directory that is a direct child of the system temp path, named `software-factory-refill-` plus 32 lowercase hex characters, with no reparse ancestors. Use a distinct root for each command. `-Group ALL` is used for full runs.

Placeholders: `C:\checkout` is the local checkout. `<temp1>` and `<temp2>` are two different fresh system temp directories.

Binding (source pin `2A97AB52A1AF82BFFF03D327C516DE26DD4338758F7317838A81E6B8F4FE1C42`):

```
pwsh -NoProfile -File tests/planning/refill-binding306.tests.ps1 -CandidatePath C:\checkout\scripts\planning\refill-binding306.ps1 -ExpectedSourceSha256 2a97ab52a1af82bfff03d327c516de26dd4338758f7317838a81e6b8f4fe1c42 -EvidenceRoot <temp1>\software-factory-refill-<32 lowercase hex> -Group ALL
```

Eligibility (source pin `AC1863301D99AEF25E43DAE26FBCEF022AA86A29FEBA92E7CC8BB06D4A0B5151`):

```
pwsh -NoProfile -File tests/planning/refill-eligibility-evidence311.tests.ps1 -CandidatePath C:\checkout\scripts\planning\refill-eligibility-evidence311.ps1 -ExpectedSourceSha256 ac1863301d99aef25e43dae26fbcef022aa86a29feba92e7cc8bb06d4a0b5151 -EvidenceRoot <temp2>\software-factory-refill-<32 lowercase hex> -Group ALL
```

## Result qualification

Each harness prints one aggregate JSON object to stdout and deletes its own anchored evidence root. It writes no standalone `receipt.json` or `result.json` and no per-case output rows. The captured stdout log plus the group aggregate and the reviewed test cases are the evidence.

- Binding aggregate from the accepted run: 144 checks as VALID 9, METADATA 36, FIELDS 99, with 0 failures.
- Eligibility aggregate from the accepted run: 69 checks as VALID 8, METADATA 27, FIELDS 34, with 0 failures.

These counts come from the group aggregates and the reviewed loops and direct cases. They are not individual log rows. Helper reuse (source and result reviews) is attributed separately and is not added to these counts.

## Limits

These files grant no ownership, evidence hash or freshness, eligibility, provider, codec, Options, gateway, current queue, transaction, READY, DONE or full Factory authority. The checks for these public files have not been run in this candidate. Accepted history is private and is not a public PASS.
