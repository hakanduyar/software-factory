# Transaction ID and Queue Entry syntax leaves

Two pure, dot-source-only Windows PowerShell leaves. They perform lexical syntax checks only. They import no other module and do not use each other.

## Exports

- `AssertRefillTransactionId296` (`scripts/planning/refill-transaction-id296.ps1`): accepts only a primitive string in canonical 36-character lowercase UUID `D` syntax. It returns a single `$true`, or throws the fixed error `REFILL296_INVALID:TYPE` or `REFILL296_INVALID:UUID`.
- `AssertRefillQueueEntry303` (`scripts/planning/refill-queue-entry303.ps1`): accepts an object with exactly six case-sensitive NoteProperties `planPath`, `receiptPath`, `provider`, `owner`, `enabled`, `id`. It returns a single `$true`, or throws a fixed `REFILL303_INVALID:<category>` error.

## Syntax limitations

- The UUID leaf does not generate UUIDs, check uniqueness, restrict version or variant, or give the nil UUID any special meaning. It has no getter or coercion path and no transaction authority.
- The queue leaf checks metadata before reading any value, so getter calls stay at zero. `provider` must be exactly `independent` or `claude` (ordinal). `enabled` must be a primitive boolean. `owner` and `id` must be non-blank, valid Unicode, at most 128 characters. The queue `id` is a raw string and is not required to be a UUID.
- Both path fields are checked lexically as canonical Windows paths. Nothing here proves a file exists, who owns it, its hash or freshness, provider eligibility, current queue state or any other authority.

## Running the harnesses (Windows PowerShell 7, drive C: only)

Both harnesses require `-CandidatePath` (canonical absolute `C:\` path, not a reparse point), `-ExpectedSourceSha256`, `-EvidenceRoot` and `-Group`. `-EvidenceRoot` must not exist yet. It must be a direct child of the system temp directory named `software-factory-refill-` plus 32 lowercase hex digits, with no reparse-point ancestors. Use a different fresh root for each command. Use `-Group ALL`. Linux is not covered.

In the examples, `C:\path\to\checkout` is a placeholder for your local checkout, and `<TEMP>` is your system temp directory.

### Transaction ID (39 checks: VALID 7, TYPES 11, FORMAT 21)

```
pwsh -NoProfile -File C:\path\to\checkout\tests\planning\refill-transaction-id296.tests.ps1 -CandidatePath C:\path\to\checkout\scripts\planning\refill-transaction-id296.ps1 -ExpectedSourceSha256 3C1D1086AA4F751AC54A7D47526CDEC5B33E158AC91287614E80BCEE44615B77 -EvidenceRoot <TEMP>\software-factory-refill-<32 lowercase hex> -Group ALL
```

The summary of per-group counts is written to `receipt.json` in the evidence root.

### Queue entry (79 checks: VALID 9, METADATA 23, FIELDS 47)

```
pwsh -NoProfile -File C:\path\to\checkout\tests\planning\refill-queue-entry303.tests.ps1 -CandidatePath C:\path\to\checkout\scripts\planning\refill-queue-entry303.ps1 -ExpectedSourceSha256 A392EBE33BE3A8659E8CBFBAFFB1FCD54038772FA9A2040B46B2BC56E965A379 -EvidenceRoot <TEMP>\software-factory-refill-<32 lowercase hex> -Group ALL
```

The result is written to `result.json` (not `receipt.json`) in the evidence root.

The two counts are separate (39 and 79) and are not added to counts from other leaves. A run passes only when the exit code is 0 and `fullAcceptance` is true with every group non-empty and zero failures.
