# TASK-002 — Durable Persistence + Run Ledger

## Objective
Replace "everything disappears on process exit" with durable local
persistence, while preserving every behavioral guarantee TASK-001 built and
proved through six adversarial review rounds: append-only audit records,
optimistic-concurrency WorkItem writes, atomic units of work, run lifecycle
terminality, and trusted-identity boundaries.

## Scope
Implement:
- a `FactoryStore` adapter backed by local SQLite (`node:sqlite`, built into
  Node — no new npm dependency, no ORM),
- the same atomic-transaction contract as the in-memory adapter, implemented
  with real SQL transactions instead of a staged overlay,
- the same optimistic-concurrency (`WorkItem.version`) and run-lifecycle
  (`RunRepository.create`/`.complete`) contracts, enforced at the SQL layer,
- the same append-only guarantee for Evidence/Review/Approval/
  AcceptanceCriterionVerification, enforced via SQLite `PRIMARY KEY`
  uniqueness,
- JSON serialization of already-JSON-safe domain values (no `Date`, only
  numeric `Timestamp`), with runtime validation of rows read back from disk,
- a minimal schema-version marker so a future migration mechanism has
  something to check against,
- integration tests proving state survives closing and reopening a store
  instance against the same database file, and proving a failed transaction
  leaves no partial writes,
- a small persistent-demo CLI path and `npm run demo:persistent` script,
- keeping the existing in-memory adapter for fast unit tests.

## Out of scope
- Claude/Codex/Gemini/OpenCode/Ollama worker execution
- model routing
- GitHub API
- n8n
- Telegram/WhatsApp
- server deployment
- an ORM or query-builder dependency
- a full migration-runner platform (only a version marker + mismatch
  detection)
- changes to TASK-001 domain/workflow invariants

## Required design constraints
- The persistence port (`src/ports/repositories.ts`) is not weakened to make
  the adapter easier to write. If a change to the port is genuinely required,
  it must preserve the same guarantees for both adapters.
- `FactoryStore.transaction` must be genuinely atomic: nothing staged inside
  a failed unit of work may become durable.
- `WorkItemRepository.compareAndSave` must reject a stale `version` rather
  than silently overwriting newer state.
- `RunRepository.complete` must reject any transition out of a terminal
  status, and must runtime-validate its input independently of TypeScript
  types (untrusted at the repository boundary).
- Append-only tables must reject id reuse.
- No `Date` object may ever be persisted.
- Data read back from the database must be validated, not merely cast.
- No secrets/config credentials in the repository; the runtime database file
  must be gitignored.

## Acceptance criteria
1. `npm run typecheck` and `npm run build` pass.
2. `npm test` passes, including new persistence-specific suites.
3. A test creates and advances Factory state through one store instance,
   closes it, opens a second store instance against the same database file,
   and confirms identical WorkItem version/history/status plus all
   runs/evidence/reviews/approvals/verifications are present.
4. A test deliberately fails a transaction (append-only violation, stale CAS,
   a run-attachment failure after the run itself was staged) and confirms no
   partial write survives.
5. The SQLite adapter and the in-memory adapter satisfy the same contract
   tests where practical (CAS rejection, append-only rejection, run lifecycle
   rejection, transaction atomicity).
6. `npm run demo` (in-memory) still passes with 15 refusals, unchanged.
7. `npm run demo:persistent` runs a full workflow against a real SQLite file
   and, on a second invocation, shows the previously persisted state without
   re-seeding.
8. README documents the database file location, the gitignore entry, and the
   exact commands.
9. Implementation report lists files changed, exact test results and known
   limitations.

## Deliverable
A clean, reviewable diff on top of the committed TASK-001 core. Do not start
TASK-003 automatically.
