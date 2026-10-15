# Authority record leaves (OwnerFact, Pin, Basis)

Three pure, definitions-only PowerShell validators. Dot-source only: no IO, hashing, encoding, JSON, codec or top-level actions. They are standalone and import nothing from the Planner or TaskFact modules.

## Public exports

### AssertRefillOwnerFact283 (scripts/planning/refill-owner-fact283.ps1)

Input shape: exactly two NoteProperty members, `ownerId` and `ownedCanonicalPaths`, with case-sensitive names. All member metadata (names, count, uniqueness, member type) is validated before any value or getter is read; a ScriptProperty is refused with zero getter calls.

- `ownerId`: primitive string, not blank, at most 128 UTF-16 code units, no unpaired surrogates.
- `ownedCanonicalPaths`: `object[]` with 1 to 64 primitive strings. Each must be a lexically canonical Windows path (drive-letter root form), and entries must be unique under case-insensitive comparison.
- Returns exactly one boolean `true`; otherwise throws `REFILL283_INVALID:<category>` with a fixed category.

Boundary: lexical only. It does not prove the actual owner, any physical filesystem state, or any authority.

### AssertRefillPin287 (scripts/planning/refill-authority-pins287.ps1)

Input shape: exactly NoteProperty `path` and `sha256`.

- `path`: primitive string, lexically canonical Windows path.
- `sha256`: primitive string matching 64 lowercase hex characters, anchored at end of string. No hashing is performed.

### AssertRefillBasisPin287 (same file)

Input shape: exactly NoteProperty `path`, `sha256`, `role`, `observedVersion`.

- `path` and `sha256` as above.
- `role`: one of `CHECKPOINT`, `PLAN`, `BACKLOG`, `WATCH` (case-sensitive).
- `observedVersion`: primitive string, not blank, at most 256 characters, valid Unicode.

Both Pin and Basis metadata is validated, with getter calls at zero, before any value is read. Errors are `REFILL287_INVALID:PIN:<category>` or `REFILL287_INVALID:BASIS:<category>`, with fixed categories and no raw input. Each export returns exactly one boolean `true`.

Boundary: syntax only. No real file hashing, evidence IO, codec, current-version lookup or transaction authority.

Source SHA-256 (full):

- refill-owner-fact283.ps1: CB45E264378C7A5ED9851095C0E6D3A5548DE3856FE5E821A0A7879DAE1BFBBA
- refill-authority-pins287.ps1: CE46E46B1A8858A08ED507A3ACDF97D84B36BB03CC0FD3BF9269D2B1BB6476A1

## Verification commands (Windows PowerShell 7, public)

Each harness takes mandatory `-CandidatePath`, `-ExpectedSourceSha256`, `-EvidenceRoot`, `-Group`. The candidate path must be a canonical absolute `C:` path to a non-reparse source file whose SHA-256 matches the externally supplied hash. The evidence root must be a fresh, absent, canonical direct child of the system temp directory named `software-factory-refill-` plus 32 lowercase hex characters, with non-reparse ancestors. Use a different fresh root for each command. `-Group ALL` is the only full acceptance.

Placeholders: `<INTEGRATION_C_ROOT>` is the canonical absolute `C:` checkout path; `<FRESH_TEMP_ROOT_A>` and `<FRESH_TEMP_ROOT_B>` are two distinct fresh roots.

OwnerFact (public 35):

```
pwsh -NoProfile -File <INTEGRATION_C_ROOT>/tests/planning/refill-owner-fact283.tests.ps1 -CandidatePath <INTEGRATION_C_ROOT>\scripts\planning\refill-owner-fact283.ps1 -ExpectedSourceSha256 cb45e264378c7a5ed9851095c0e6d3a5548de3856fe5e821a0a7879dae1bfbba -EvidenceRoot <FRESH_TEMP_ROOT_A> -Group ALL
```

Expected: 35 assertions, groups VALID 6, METADATA 15, SHARED 14, all nonempty.

Pin/Basis (public 84):

```
pwsh -NoProfile -File <INTEGRATION_C_ROOT>/tests/planning/refill-authority-pins287.tests.ps1 -CandidatePath <INTEGRATION_C_ROOT>\scripts\planning\refill-authority-pins287.ps1 -ExpectedSourceSha256 ce46e46b1a8858a08ed507a3acdf97d84b36bb03cc0fd3bf9269d2b1bb6476a1 -EvidenceRoot <FRESH_TEMP_ROOT_B> -Group ALL
```

Expected: 84 assertions, groups PIN 18, BASIS 36, METADATA 30, all nonempty.

## Evidence attribution

The 35 and the 84 are separate fresh counts and are never added together. The shared lexical helpers (Fail, TestUnicode, PathCategory) are reused by normalized-AST identity from accepted prior reviews; those prior Planner and TaskFact matrices are not rerun and not counted here. OwnerFact reuses helper identity for Fail, TestUnicode and PathCategory. Pin/Basis reuses identity only for TestUnicode and PathCategory; its Fail function differs (it carries a kind), so its fixed error routing is covered by fresh assertions.

## Scope and non-claims

Windows and `C:` harness scope only; no cross-platform claim. This README and these modules grant no actual ownership, no evidence existence, hash or freshness, no eligibility, no codec, Options, gateway, queue, READY, DONE or full Factory authority. Public candidate verification is NOT_RUN; accepted private history does not prove a public PASS.
