# Source-only WorkerResult example predicate

Status: SOURCE_ONLY_NOT_RUN. This README describes `scripts/controller/source-author-result-example321.ps1` and its harness `tests/controller/source-author-result-example321.tests.ps1`. Both are exact byte copies of accepted baselines. Neither has been edited.

## Contract

`AssertSourceAuthorResultExample321` is a pure predicate with no IO. It takes `ExampleJson`, `PacketText` and `ExpectedChangedPaths`, and either returns `$true` or throws `SOURCE_EXAMPLE321_INVALID:<CODE>`.

- The example must be a JSON object with exactly the eight WorkerResult keys. Duplicate, missing, extra and case-variant keys are refused.
- `commandsRun` and `blockers` must be empty arrays.
- `validationResults` must be exactly `["NOT_RUN"]`.
- `fingerprint` and `checkpointRef` must be null.
- `summary` and `recommendedNextAction` must be nonblank strings of at most 512 characters.
- The example is bounded to 2048 UTF-8 bytes, the packet to 131072 UTF-8 bytes, and the JSON depth to 4.
- `changedPaths` has 1 to 32 entries, with no duplicates. Its set must equal `ExpectedChangedPaths` under ordinal comparison.

## Limits of the claim

- Matching `ExpectedChangedPaths` is plain ordinal string matching. It is not filesystem canonicalization, confinement, ownership or permissions.
- Packet membership means the example JSON appears as a literal ordinal substring of the packet text. It is not full packet parsing and does not enforce a singleton.
- It does not establish current ownership, authority, or acceptance of any actual WorkerResult.
- It uses host .NET `System.Text.Json` on Windows PowerShell 7.6. Pure host .NET use does not establish Linux harness support.
- JSON document disposal and rethrow of unknown exceptions are verified by static qualification only. There are no dynamic tests for them. The unsupported property-name exception case is not proven.
- Nothing here grants adoption into runtime or dispatch, and nothing covers private preflight code, 264, options, codec, authority or any grant.

## Verification command (Windows)

The harness takes `-CandidatePath`, which must be a canonical `C:` path with single backslash separators. It also takes the expected source SHA-256, which is supplied externally and pinned to the source baseline. `-EvidenceRoot` must be a fresh, absent directory directly under the system temp directory, named `software-factory-refill-` followed by 32 lowercase hex characters. The harness rejects reparse-point ancestors. Pin the candidate SHA to the exact candidate under review.

```
pwsh -NoProfile -File C:\path\to\checkout\tests\controller\source-author-result-example321.tests.ps1 -CandidatePath C:\path\to\checkout\scripts\controller\source-author-result-example321.ps1 -ExpectedSourceSha256 cc5197aa83e93170f79face5a84df072e8636d90dcd8eb1cf4395ebe04c63f2f -EvidenceRoot C:\Users\<user>\AppData\Local\Temp\software-factory-refill-<32 lowercase hex> -Group ALL
```

Replace `C:\path\to\checkout` with the canonical checkout path, `<user>` with the Windows user name, and `<32 lowercase hex>` with fresh random hex.

`-Group ALL` yields 24 Check rows: VALID 5, METADATA 10 and FIELDS 9. Compound internal expressions do not inflate those counts. The harness prints one stdout JSON aggregate only. No standalone receipt is written, so the receipt is null. It deletes its own temp root at the end. The exit code is 0 only when all three groups are nonempty with zero failures.

No new checks are claimed beyond these 24 rows.
