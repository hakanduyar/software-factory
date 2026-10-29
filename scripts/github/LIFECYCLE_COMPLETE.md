# Verified auto-close lifecycle (COMPLETE) — opt-in source capability

`Invoke-DurableGitHubTaskComplete` in `task-lifecycle-mirror-consumer.ps1` closes the mapped GitHub issue and
projects the terminal state into the paired local note, but only for one explicitly admitted, fully proven
COMPLETE packet. It is a separate entrypoint: `Invoke-AdmittedTaskLifecycleUpdate`, its `TaskLifecycleUpdateRelease`
v1/v2 schemas, its journal and its retry behaviour are unchanged, and an UPDATE release or packet can never close an
issue. CREATE callers are unchanged.

## What this is not

- It does not grant approval. No JSON pin, receipt or this code authorizes anything. A human must separately
  admit the exact host invocation (release, review and native-request hashes), following the existing trusted
  publication boundary (`execute-reviewed-publication`).
- It does not authenticate external facts. The receipts are structural claims; an **external independent reviewer**
  must have authenticated their origin and that they map exactly to this task, revision and candidate commit. Hashes
  only prove the pinned bytes did not change; they never prove remote truth (merge, checks, tests).
- It never trusts "an LLM said DONE", raw caller booleans or task status alone. It writes no FactoryDB or domain DONE
  state, starts no next task or provider, creates/searches/reopens no issue and has no scheduler or default retry.
- Fixtures in `tests/github/lifecycle-verified-complete.tests.ps1` are offline mechanics only and can never
  authorize closing an actual issue.

## Required real publication tuple

Closure needs all of the following, jointly. Any one missing, failed, mismatched, coerced or drifted refuses.

1. A canonical COMPLETE packet (`TaskLifecycleMirrorPacket/v1`, `eventType` `COMPLETE`, `publicStatus`
   `ACCEPTED_SCOPED`, `nextAction` `NONE`). `NONE` is accepted only for COMPLETE; the other packet enums are unchanged.
2. `LifecycleCompletionProof/v1` (exact keys): `schema`, `taskId`, `canonicalRevision`, `candidateCommit`,
   `minimumFocusedTests`, `sourceReview`, `delivery`.
   - `taskId` and `canonicalRevision` equal the COMPLETE packet; `candidateCommit` is a nonzero lowercase 40-hex commit.
   - `minimumFocusedTests` is a positive JSON integer (no boolean, string or float coercion).
   - `sourceReview` and `delivery` are `{path, sha256}` pins of distinct ordinary files (absolute, normalized,
     no reparse points, lowercase 64-hex), re-authenticated on every use.
3. `sourceReview` target, `IndependentComponentReview/v1`: `decision` `ACCEPT_SCOPED_SOURCE`, `commit` nonzero
   lowercase 40-hex and equal to `candidateCommit`.
4. `delivery` target, `IndependentDeliveryReceipt/v1`: `head` equal to the review commit and candidate, `merge` nonzero
   lowercase 40-hex, `pr` exactly `https://github.com/hakanduyar/software-factory/pull/<positive integer>`,
   `requiredChecks` `ALL_SUCCESS`, `checks` positive integer, `normalTypecheck` `PASS`, `normalBuild` `PASS`,
   `focusedTests` positive integer `>= minimumFocusedTests`, `sourceReviewSha256` equal to the `sourceReview` pin.
   Other descriptive receipt fields are inert. Duplicate (including case-alias duplicate) keys, aliases and
   malformed relevant fields refuse; unsupported receipt schemas refuse. Prose is never parsed.

## Admission documents (no approval boolean)

`TaskLifecycleCompleteRelease/v1` keys: `schema`, `packet`, `canonical`, `mapping`, `beforeIssue`, `beforeNote`,
`review`, `nativeRequest`, `consumer`, `transport`, `executable`, `completionProof` (pins), `stateDir`, `vaultRoot`,
`notePath`, `outboxPath`, `journalPath`, `canonicalLease`, `publisherLease`, `tempRoot`, `outboxSha256`, `recovery`
(`INITIAL` or `RECONCILE_MISSING`). `journalPath` must be `<stateDir>/lifecycle-complete.journal.json`.

`LifecycleCompleteIndependentReview/v1` keys: `schema`, `decision` (`ADMIT`), `packetSha256`, `consumerSha256`,
`transportSha256`, `completionProofSha256`, `taskId`, `canonicalRevision`, `candidateCommit`.

`LifecycleCompleteNativeRequest/v1` keys: `schema`, `action` (`COMPLETE`), `packetSha256`, `reviewSha256`,
`consumerSha256`, `transportSha256`, `executableSha256`, `completionProofSha256`, `taskId`, `canonicalRevision`,
`candidateCommit`, `stateDir`, `notePath`, `outboxPath`.

The existing source, executable, path, mapping (stable marker, task, issue identity), canonical-lease and
publisher-lease guards are reused. All pins and the whole proof chain are re-authenticated under both leases and
again immediately before every EDIT, CLOSE and note write.

## Flow and durability

1. READ the mapped issue (exact number/URL). It must be OPEN with the reviewed before content, OPEN with the exact
   desired content, or CLOSED with the exact desired content; anything else refuses (`DESTINATION_DRIFT`).
2. If still before: persist `editSent`, perform the existing exact compare-before-write EDIT of the managed region
   (the transport allows `Next action: NONE` only with `ACCEPTED_SCOPED`, EDIT after-body only), READ back exact
   OPEN desired content, persist `editAck`.
3. Persist `closeSent`, call transport `CLOSE`, READ back CLOSED with exact identity/title/body, persist `closeAck`.
4. Update the paired note's existing reviewed fields to the terminal projection (including `Issue state: CLOSED`),
   preserving identity and outside bytes, then hash-read it back. The note destination is verified local bytes, not
   an external Obsidian ACK.
5. `DELIVERED` only when GitHub (CLOSED + exact content) and the note bytes both ACK; otherwise `PENDING` truth is
   retained and replay is idempotent.

State lives in `LifecycleCompleteJournal/v1` (own file; the UPDATE journal is never read or written). Events are
exact-shape (`taskId`, `canonicalRevision`, `digest`, `proofSha256`, `editSent/Ack`, `closeSent/Ack`,
`noteSent/Ack`); unrelated events and outbox rows are validated and preserved. Same key with a different payload or
proof refuses. A sent marker is written durably before each remote call and an ACK only after verified readback.

Transport `CLOSE` takes exactly `repo`, `issueNumber`, `taskId`, `title`, `body`; validates the terminal
managed region and stable marker, performs its own READ requiring OPEN and exact identity/title/body, then runs the
fixed argv `gh issue close <n> --repo hakanduyar/software-factory --reason completed` (no shell) and returns
`{ok, operation='CLOSE', number, url}`. Failure carries only the existing typed diagnostic.

## Recovery

An existing sent marker needs a separately admitted `RECONCILE_MISSING` release, and then only
authenticated readback is used: an already CLOSED desired issue is adopted with zero EDIT/CLOSE; a CLOSE that was
sent but left the issue OPEN returns `PENDING` `CLOSE_AMBIGUOUS_NO_RETRY`, and an EDIT that was sent but left the
before content returns `EDIT_AMBIGUOUS_NO_RETRY` — neither is ever repeated automatically, even under
`RECONCILE_MISSING`. Resolving them is a human decision outside this capability.

## Verification

```
pwsh -NoProfile -File tests/github/lifecycle-verified-complete.tests.ps1 -SourcePath <abs>/scripts/github/task-lifecycle-mirror-consumer.ps1 -EvidenceRoot <fresh abs dir>
```

Offline only (injected process runners; the real transport builds and parses the actual `gh` argv). The existing
UPDATE/retry/transport tests remain independent regression and CI. Note that they pin the previous transport
SHA-256; this change necessarily changes the transport, so that pin needs a reviewer-owned update before they pass.
