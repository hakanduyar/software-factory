# AI HANDOFF

Status: IMPLEMENTED_AWAITING_VERIFICATION
Current task: TASK-002
Plan version: persistence-v1

Prior task: TASK-001 (Local Factory Core Skeleton) shipped as commit
`5071079` after six independent review rounds. Its full implementer/reviewer
history is archived at `docs/tasks/archive/TASK-001-AI-HANDOFF.md`.

## Implementer output

Worker: Claude Code (Sonnet 5), role IMPLEMENTATION ENGINEER.

Wrote `docs/tasks/TASK-002-persistence.md` before implementation (per
protocol), then added a second `FactoryStore` adapter — `src/adapters/sqlite/`
— backed by `node:sqlite` (built into Node since 22.5; zero new npm
dependencies, no ORM). It satisfies the exact same port
(`src/ports/repositories.ts`) as the in-memory adapter, so **no line of
`src/domain/`, `src/workflow/`, or `src/app/factoryService.ts` changed**. The
port itself was not weakened.

### Design

- **Schema** (`src/adapters/sqlite/schema.ts`): eight tables, one per
  repository, each storing the full domain record as a JSON `data` column
  (domain values are already JSON-safe — see TASK-001's `Timestamp`/
  `deepFreeze` work) plus the columns each method needs to query or enforce
  invariants on without parsing JSON first: `work_items.version` (CAS token),
  `runs.status` (lifecycle guard), and `work_item_id` / `subject_type`+
  `subject_id` indexes for the `listByX` queries. A `schema_meta` table
  stamps a `schema_version`; opening a database written by a different
  version throws `SchemaVersionError` rather than guessing (the "smallest
  sensible" versioning baseline the task asked for — no migration runner).
- **Serialization** (`src/adapters/sqlite/serialization.ts`): every row read
  back from disk is validated field-by-field (enum membership, numeric
  finiteness, array shape) before being trusted as a domain value, not cast.
  A malformed row throws `PersistenceCorruptionError`.
- **Transactions**: SQLite provides real ACID transactions, so unlike the
  in-memory adapter's staged-overlay-plus-revalidation, this adapter writes
  directly inside `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`. `node:sqlite`'s
  `DatabaseSync` is one synchronous connection — two overlapping transactions
  on it is a hard SQLite error, and letting one write slip into another's
  open transaction would be worse than not atomic. A small FIFO in-process
  mutex (`createMutex` in `sqliteStore.ts`) serializes every `transaction()`
  call — including the single-operation ones each top-level repository
  method opens, mirroring the in-memory adapter's `solo` helper — so exactly
  one logical unit of work ever touches the connection at a time.
- **CAS and run lifecycle**: real conditional SQL — `UPDATE work_items SET
  ... WHERE id = ? AND version = ?` and `UPDATE runs SET ... WHERE id = ? AND
  status = 'RUNNING'` — checked via `changes`, rather than comparing
  separately-read values.
- **Append-only tables**: SQLite's own `PRIMARY KEY` `UNIQUE` constraint; the
  violation is translated to `AppendOnlyViolationError`.
- **Shared logic, not duplicated**: `captureRun`/`captureCompletion` (the
  Round-4/5 single-read-before-validate defense against hostile getters) were
  extracted from the in-memory adapter into `src/adapters/shared/
  runCapture.ts` and are now used by **both** adapters, so this guarantee
  cannot silently diverge between them (the in-memory adapter's behavior is
  unchanged — this was a pure extraction, re-verified by the full existing
  suite staying green).

### One genuine, documented behavioral difference

The in-memory adapter's `transaction()` opens an independent overlay per
call, so two *concurrent* calls can each read the same pre-race snapshot and
race on the final write (one wins, one gets `ConcurrencyError`). The SQLite
adapter's mutex fully serializes transactions, so a second transaction's read
always sees the first's already-committed result — closer to a real
database's behavior under `BEGIN IMMEDIATE`. Concretely: two concurrent
`FactoryService.advance()` calls can produce one CAS-rejected loser against
the in-memory store; against SQLite, the second call's fresh read may find a
*different* legitimate transition and succeed too, rather than losing a race.
Neither is a bug — races are still never allowed to corrupt state or
double-apply a change — but two of my first-draft rollback tests assumed the
in-memory adapter's specific interleaving and had to be rewritten around a
genuinely stale externally-held snapshot instead of a same-process race; see
`tests/persistenceRollback.test.ts` for the corrected tests and the comments
explaining why. This is documented in the README's persistence section.

### Restart and rollback proof

- `tests/persistenceRestart.test.ts`: builds a fully-released work item
  through one store instance, closes it, opens a second instance against the
  same file, and confirms identical status/version/specRevision/history plus
  every run/evidence/review/approval/criterion-verification, and that a
  brand-new `FactoryService` on the reopened store still enforces every
  invariant (forged cancellation refused, a new worker run succeeds).
- `tests/persistenceRollback.test.ts`: an append-only violation mid-
  transaction, a thrown worker, a concurrent run-start race, and a
  stale-snapshot write are each proven to leave no partial write.
- `tests/support/storeContract.ts` + `tests/sqliteStore.test.ts`: the same
  CAS/append-only/run-lifecycle/atomicity/frozen-return/Date-rejection/
  insertion-order assertions run against **both** adapters from one shared
  test body, proving parity (acceptance criterion 5).
- `sf demo:persistent` / `npm run demo:persistent`: seeds a full lifecycle to
  DONE, closes and reopens the store in-process, then — run a second time as
  a genuinely new OS process — reads back the same state with no re-seeding.
  Manually verified twice in a row from a clean `.factory-data/`; also
  covered headlessly by `tests/persistentDemo.test.ts`.

### Commands run (clean state)

- `rm -rf node_modules dist` → `npm install --registry=https://registry.npmjs.org` — OK (default registry unreachable from this machine, same as TASK-001)
- `npm run typecheck` — PASS
- `npm run build` — PASS
- `npm test` — **219 tests, 219 pass, 0 fail** (up from 188 at the end of TASK-001; +31 new tests across 6 new test files)
- `npm run demo` (in-memory) — unchanged: DONE, 15 refusals
- `npm run demo:persistent` — run twice from a clean `.factory-data/`: first run seeds to DONE and proves in-process restart; second run (new OS process) reads back identical state with no re-seeding
- `git diff --check` — clean
- `git status --short` — inspected; `.factory-data/` correctly absent (gitignored)

### Files created/modified

Created: `docs/tasks/TASK-002-persistence.md`, `docs/tasks/archive/TASK-001-AI-HANDOFF.md` (archival copy), `src/adapters/sqlite/{schema,serialization,sqliteStore}.ts`, `src/adapters/shared/runCapture.ts`, `src/cli/persistentDemo.ts`, `tests/{sqliteStore,persistenceRestart,persistenceRollback,persistentDemo}.test.ts`, `tests/support/storeContract.ts`.

Modified: `package.json` (engines bumped to `>=22.5.0`, added `demo:persistent` script), `.gitignore` (runtime DB files), `src/adapters/memory/inMemoryStore.ts` (import shared `captureRun`/`captureCompletion` instead of local duplicates — no behavioral change), `src/cli/main.ts` (added `demo:persistent` command, lazy-imported so plain `sf demo` never loads `node:sqlite`), `src/domain/errors.ts` (added `PersistenceCorruptionError`, `SchemaVersionError`), `tests/support/factoryFixtures.ts` (added `newSqliteFactory`, `tempDbPath`), `README.md`, `LOOP.md`, `LOOP-PLANS.md`, `AI-HANDOFF.md` (reset for TASK-002; TASK-001's full record archived rather than deleted).

Not done, by design: no commit, no push, no merge; TASK-003 not started; no Claude/Codex worker execution, model routing, GitHub, n8n, Telegram, server deployment or content pipeline added; no ORM/query-builder dependency; no migration-runner platform (only version detection); the Constitution was not modified.

## Implementer remediation (Round 2)

Worker: Claude Code (Sonnet 5), role IMPLEMENTATION ENGINEER, responding to
the CHANGES_REQUIRED review below. Both HIGH findings are fixed. Scope was
kept to `src/adapters/sqlite/{schema,serialization,sqliteStore}.ts`,
`src/domain/errors.ts`, `tests/support/factoryFixtures.ts` (temp-dir
cleanup), and one new test file — no TASK-003 work, no port changes, no
weakening of any TASK-001/TASK-002 invariant.

### 1. Root cause of both HIGH findings

- **Finding 1 (schema masquerade):** `ensureSchema()` ran `CREATE TABLE IF
  NOT EXISTS` unconditionally and only ever checked
  `schema_meta.schema_version`. A table that kept the right name but lost its
  `PRIMARY KEY` (or any other constraint/column/index) was never inspected,
  so it silently passed as "version 1" — losing append-only protection
  without any error.
- **Finding 2 (deserialization trusts unchecked data):** the parsers checked
  JSON shape and enum membership, but (a) never compared the indexed SQL
  columns (`work_items.version`, `runs.status`, `approvals.subject_id`, ...)
  against the JSON payload they're supposed to mirror, and (b) didn't
  validate every domain lifecycle invariant — a WorkItem could carry a
  negative `version`, and a Run could be RUNNING with `finishedAt` set, and
  both would be returned as if trusted.

### 2. Schema-open invariant introduced

`ensureSchema()` (`src/adapters/sqlite/schema.ts`) now strictly orders its
checks so no DDL that could change table structure ever runs against an
existing database:

1. Is there a `schema_meta` table at all?
   - No, and no other Factory-named table exists either → genuinely fresh
     database; this is the *only* path that runs `SCHEMA_DDL` and stamps the
     version.
   - No, but some Factory-named table *does* exist → `SchemaIntegrityError`
     (a database with Factory tables but no version marker is neither fresh
     nor trustworthy).
2. Does `schema_meta` have a `schema_version` row? No → `SchemaIntegrityError`.
3. Does the stored version match `SCHEMA_VERSION`? No → `SchemaVersionError`,
   with zero DDL executed before the throw.
4. Version matches → `validateSchema()` (see below) runs; any mismatch there
   also throws before any table is used. An existing, version-matched
   database is validated, never "repaired".

### 3. Full-schema validation performed

`validateSchema()` walks a fixed `EXPECTED_TABLES` spec (kept in sync with
`SCHEMA_DDL` by hand — TASK-002 intentionally has no schema-derivation
framework) and, per table, checks via `PRAGMA table_info(...)` and
`sqlite_master`: the table exists; every expected column exists with the
right type/`NOT NULL`/`PRIMARY KEY` flags (this is what catches the
reviewer's exact repro — an `evidence` table missing `PRIMARY KEY` on `id`);
and every index this adapter's queries rely on
(`idx_work_items_project_id`, ..., `idx_approvals_subject`) exists. Table
names interpolated into `PRAGMA table_info("...")` always come from the
fixed constant, never from external input.

### 4. Runtime persisted-record validation introduced

`src/adapters/sqlite/serialization.ts` gained a `positiveInt` validator (used
for `WorkItem.version`/`specRevision`, `Run.specRevision`,
`Review.specRevision`, `AcceptanceCriterionVerification.specRevision`, and
`ApprovalContext.specRevision` — confirmed always ≥1 by how
`src/app/factoryService.ts`/`src/workflow/workflowService.ts` initialize and
increment them) plus two lifecycle-coherence checks:
- `WorkItem.blockedFrom` is now required iff `status === "BLOCKED"` (and
  forbidden otherwise), matching `workflowService.ts`'s actual invariant.
- `Run.finishedAt` is now required iff `status !== "RUNNING"` (terminal), and
  forbidden while RUNNING, matching `run.ts`'s documented lifecycle.
- `ApprovalContext.statusWhenDecided` is now validated against
  `WORK_ITEM_STATUSES` (was a bare string before).

### 5. SQL/JSON cross-checks introduced

Every `parseX` function now takes an `expected` parameter carrying the
row's indexed SQL columns and throws `PersistenceCorruptionError` (via a new
shared `crossCheck` helper) on any mismatch against the decoded JSON:
`Project.id`; `WorkItem.id`/`projectId`/`version`;
`AcceptanceCriterion.id`/`workItemId`; `Run.id`/`workItemId`/`status`;
`Review.id`/`workItemId`; `Evidence.id`/`workItemId`;
`AcceptanceCriterionVerification.id`/`workItemId`;
`Approval.id`/`subject.type`/`subject.id`. `sqliteStore.ts`'s `SELECT`
statements were widened to fetch these columns alongside `data`, and every
call site (`findById`, `listByX`, plus the CAS-conflict lookup inside
`compareAndSave`) now passes them through. Neither the SQL column nor the
JSON value is ever preferred silently — any disagreement is a hard refusal.

### 6. Proof regression tests failed before fixes

New `tests/persistenceCorruption.test.ts` (27 tests) was written and run
against the pre-fix code first: **15 of 27 failed**, reproducing both HIGH
findings exactly as described —
- schema-shape tests (missing `PRIMARY KEY`, missing `version`/`status`
  column, missing index, tables-without-marker) all failed to throw;
- the `work_items.version=77` / JSON `version=-1` cross-check, `runs.status`
  divergence, and `approvals.subject_id` divergence cases all failed to
  throw;
- `blockedFrom` incoherence, `Run` RUNNING-with-`finishedAt`,
  terminal-without-`finishedAt`, and non-positive `specRevision` cases all
  failed to throw;
- the negative-version and non-integer-version WorkItem cases failed to
  throw (the pre-fix `num()` validator accepted any finite number).

After the fixes above, the same 27/27 pass. The "B" test (incompatible
version must not mutate) already passed before the fix — `CREATE TABLE/INDEX
IF NOT EXISTS` were already no-ops against an existing schema — but is kept
as a permanent regression guard, proven via a full `sqlite_master` +
row-count snapshot taken before and after the refused open.

### 7. Files changed

Modified: `src/domain/errors.ts` (added `SchemaIntegrityError`),
`src/adapters/sqlite/schema.ts` (ordered version/shape validation before any
DDL, added `EXPECTED_TABLES` + `validateSchema`),
`src/adapters/sqlite/serialization.ts` (added `positiveInt`, `crossCheck`;
every `parseX` now takes and checks `expected` metadata; added
`blockedFrom`/`finishedAt`/`statusWhenDecided` coherence checks),
`src/adapters/sqlite/sqliteStore.ts` (`SELECT`s widened to fetch indexed
columns; every parse call site passes them through; added row-shape
interfaces), `tests/support/factoryFixtures.ts` (added `cleanupTempDbs()`;
`tempDbPath()` now tracks what it creates — Round-2 LOW finding),
`tests/persistenceRestart.test.ts` and `tests/persistentDemo.test.ts`
(wired `after(cleanupTempDbs)`).

Created: `tests/persistenceCorruption.test.ts` (27 tests: schema integrity,
SQL/JSON cross-checks, invalid-domain-value rejection).

Not touched: the persistence port, the in-memory adapter, domain/workflow
code, README (out of this round's stated scope), any TASK-003 work.

### 8. Exact verification results (clean state)

- `rm -rf node_modules dist` → `npm install --registry=https://registry.npmjs.org` — OK
- `npm run typecheck` — PASS
- `npm run build` — PASS
- `npm test` — **246 tests, 246 pass, 0 fail** (up from 219; +27 from the new corruption suite)
- `node --test dist/tests/persistenceCorruption.test.js` — 27/27 pass (run standalone to confirm in isolation)
- `npm run demo` — DONE, 15 refusals, unchanged
- `npm run demo:persistent` run twice (seed, then a second real OS process reading back) — unchanged behavior, version 12, runs=3, evidence=6 both times
- `git diff --check` — clean
- `git status --short` — matches the files listed above; confirmed no leftover temp directories under `/tmp` after the new/updated tests run (`ls /tmp | grep -E "factory-test-|factory-corrupt-|persistent-demo-"` → empty)

### 9. Remaining limitations

- `EXPECTED_TABLES` in `schema.ts` is hand-kept in sync with `SCHEMA_DDL`
  rather than derived from one source — acceptable for TASK-002's "no schema
  framework" scope, but a future migration mechanism should consider
  generating one from the other.
- Schema validation checks column name/type/`NOT NULL`/`PRIMARY KEY` and
  index presence; it does not re-verify `STRICT`/`WITHOUT ROWID` table
  options or foreign-key definitions (none are relied on for correctness
  here — `PRAGMA foreign_keys = OFF` is set deliberately, see original
  design notes above).
- All prior TASK-002 limitations still apply unchanged (single-writer mutex,
  no migration runner, local-file-only, `node:sqlite` still experimental
  upstream).

### 10. Ready for independent re-review: YES

## Implementer remediation (Round 3)

Worker: Claude Code (Sonnet 5), role IMPLEMENTATION ENGINEER, responding to
the Round-2 re-review's two HIGH and two MEDIUM findings below. All four are
fixed. Scope stayed inside `src/adapters/sqlite/schema.ts` (the file every
finding this round is about) plus two new test files and one new shared test
helper — no other adapter file, port, or domain code changed.

### 1. Root causes

- **HIGH — failed opens still mutated the target DB:** `ensureSchema()` ran
  `PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = OFF` unconditionally
  as its first two statements, before any classification of the database had
  happened. A refused open (unsupported version, corrupt schema, unrelated
  DB) still left `journal_mode` changed from `DELETE` to `WAL` — a real,
  persistent mutation of a database the store was about to reject.
- **HIGH — unrelated non-empty DB treated as fresh:** the "is this a fresh
  database" check only asked "does a Factory-named table exist?". A database
  with unrelated user tables (no Factory tables, no `schema_meta`) has no
  Factory-named table either, so it satisfied that check and had the full
  Factory schema silently installed into someone else's database file.
- **MEDIUM — malformed `schema_meta` could leak a raw SQLite error:** the
  version lookup (`SELECT value FROM schema_meta WHERE key = ...`) ran
  immediately once a table named `schema_meta` was found, with no check that
  it actually had a `value` column. A `schema_meta` missing that column made
  the query itself throw a raw `ERR_SQLITE_ERROR` ("no such column: value")
  instead of a controlled `SchemaIntegrityError`.
- **MEDIUM — index validation checked names, not definitions:** the index
  check was `SELECT name FROM sqlite_master WHERE type='index' AND name=? AND
  tbl_name=?` — proof an index with that name exists on that table, not proof
  of what column(s) it actually indexes. An index recreated under the
  expected name but over the wrong column (or a composite index with its
  columns swapped) passed silently.

### 2. Read-only DB classification design

`ensureSchema()` now delegates to a new `classifyDatabase()` that performs
*only* read-only introspection — `sqlite_master` queries, `PRAGMA
table_info`/`index_list`/`index_info`, and plain `SELECT`s — and returns one
of five classifications without ever executing DDL or a mutating `PRAGMA`:
`EMPTY`, `CURRENT_FACTORY`, `UNSUPPORTED_FACTORY_VERSION` (carries the raw
stored version string), `CORRUPT_OR_INCOMPLETE_FACTORY` (carries a reason),
or `NON_FACTORY_NONEMPTY` (carries a reason). `ensureSchema()` then does a
single `switch` on the result — the *only* place any mutating statement
executes, and only in the `EMPTY` and `CURRENT_FACTORY` arms.

### 3. When mutating PRAGMAs now execute

`PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = OFF` now execute in
exactly two places, both *after* classification has already decided the
database is safe: the `EMPTY` arm (immediately before the one-time
`SCHEMA_DDL` + version-stamp insert), and the `CURRENT_FACTORY` arm (after
`classifyDatabase` has already run full column/index validation on every
table). Every other arm (`UNSUPPORTED_FACTORY_VERSION`,
`CORRUPT_OR_INCOMPLETE_FACTORY`, `NON_FACTORY_NONEMPTY`) throws without
executing a single statement beyond the read-only classification queries.

### 4. Empty vs non-Factory DB rule

`listUserSchemaObjects()` selects every `sqlite_master` row and filters out
anything whose name starts with `sqlite_` (SQLite's own internal bookkeeping
objects — `sqlite_sequence`, `sqlite_stat1`, etc.). A database is `EMPTY` iff
that filtered list has zero rows — no tables, indexes, triggers, or views of
any kind, Factory or otherwise. Anything else falls through to the
Factory-marker check (`CORRUPT_OR_INCOMPLETE_FACTORY` if some Factory-named
table exists without a marker, `NON_FACTORY_NONEMPTY` otherwise) — there is
no longer a path where "no Factory-named table happens to exist yet" is
treated as license to initialize.

### 5. `schema_meta` structural validation

`validateTableColumns()` (extracted from the combined column+index validator
used in Round 2) is called against the `schema_meta` table's own shape
*before* the version row is ever queried. Only if that structural check
passes does `classifyDatabase` run `SELECT value FROM schema_meta WHERE key =
'schema_version'` — wrapped in its own `try/catch` that converts any
unexpected error into `CORRUPT_OR_INCOMPLETE_FACTORY` rather than letting it
propagate raw. It also now checks the query returns exactly one row (not
zero, not more than one — duplicate `schema_version` rows are only possible
if `schema_meta`'s `PRIMARY KEY` was itself removed, which the structural
check above would normally already have caught, but the row-count check is a
second, independent guard). Finally, a `schema_version` value that fails
`Number.isInteger` is classified `CORRUPT_OR_INCOMPLETE_FACTORY`, not
`UNSUPPORTED_FACTORY_VERSION` — `SchemaVersionError` is now reserved
specifically for "a structurally valid Factory schema declares a known,
well-formed, but unsupported version number."

### 6. Index-definition validation

`ExpectedIndex` now carries `columns: readonly string[]` (in order) and
`unique: boolean`, not just a bare name. `validateTableIndexes()` looks up
each expected index via `PRAGMA index_list(table)` (checking existence and
the `unique` flag), then `PRAGMA index_info(indexName)` — sorted by `seqno`
— and compares the resulting column sequence element-by-element against the
expected columns, in order. `idx_approvals_subject`'s expected columns are
`["subject_type", "subject_id"]`, so a same-named index built as
`(subject_id, subject_type)` now fails validation. Only the seven indexes
this adapter's queries actually rely on are declared in `EXPECTED_TABLES`;
no attempt is made to enumerate or reject indexes the implementation doesn't
use.

### 7. Proof all four regression cases failed before fixes

New `tests/persistenceSchemaOpening.test.ts` (14 tests, plus a new shared
`tests/support/dbSnapshot.ts` helper for the "before vs. after a refused
open" comparisons) was run against the pre-fix code first: **6 of 14
failed**, reproducing every finding —
- the journal-mode/full-snapshot test failed (`journal_mode` became `wal`
  after a refused open);
- the unrelated-non-empty-database test failed (no throw at all — the
  Factory schema was installed into it);
- the "`schema_meta` missing its `value` column" case failed (a raw SQLite
  error, not `SCHEMA_INTEGRITY_VIOLATION`, propagated);
- the "non-integer `schema_version` value" case failed (it threw
  `SCHEMA_VERSION_MISMATCH` instead of `SCHEMA_INTEGRITY_VIOLATION` — the
  reserved-for-valid-version-only rule from finding 5 above);
- both wrong-index-definition cases failed (wrong single column; swapped
  composite-index column order) — the pre-fix code only checked the index
  name existed.

The remaining 8 (already-empty DB still initializes; internal
`sqlite_*`-only DB still initializes; missing-PK/no-version-row/duplicate-
rows/wrong-column-type `schema_meta` cases; missing-index and
correct-index-passes cases) already passed pre-fix, since Round 2's
`validateSchema` already covered them as part of full post-version-check
validation — they are kept as permanent regression guards for this round's
restructuring. After the fixes above, all 14/14 pass.

### 8. Files changed

Modified: `src/adapters/sqlite/schema.ts` (the entire classification/
validation/`ensureSchema` design described above; `EXPECTED_TABLES`' index
entries now carry `columns`/`unique`; `SCHEMA_DDL` exported for test use).

Created: `tests/persistenceSchemaOpening.test.ts` (14 tests: read-only-
refusal proof, unrelated-DB refusal, empty-DB precision, `schema_meta`
structural validation, index-definition validation),
`tests/support/dbSnapshot.ts` (reusable `snapshotDb`/`readJournalMode`
before/after comparator).

Not touched: `src/adapters/sqlite/serialization.ts`, `sqliteStore.ts`, the
persistence port, the in-memory adapter, domain/workflow code, README, any
TASK-003 work. (The reviewer's report also notes stored-value payloads
appearing in some `PersistenceCorruptionError` messages via `JSON.stringify`
— this was not one of the four findings enumerated for this round's scope
and was left untouched; flagged under Remaining limitations below for a
follow-up round if wanted.)

### 9. Exact verification results (clean state)

- `rm -rf node_modules dist` → `npm install --registry=https://registry.npmjs.org` — OK
- `npm run typecheck` — PASS
- `npm run build` — PASS
- `npm test` — **260 tests, 260 pass, 0 fail** (up from 246; +14 from the new schema-opening suite)
- `node --test dist/tests/persistenceSchemaOpening.test.js` — 14/14 pass standalone
- `node --test dist/tests/persistenceCorruption.test.js` — 27/27 pass standalone (Round-2 suite unaffected)
- `npm run demo` — DONE, 15 refusals, unchanged
- `npm run demo:persistent` run twice (seed, then a second real OS process reading back) — unchanged: version 12, runs=3, evidence=6 both times
- `git diff --check` — clean
- `git status --short` — matches the files listed above; no leftover temp directories under `/tmp` after the new tests run

### 10. Remaining limitations

- The reviewer's Round-2 re-review also flagged that some
  `PersistenceCorruptionError` messages echo `JSON.stringify` of stored
  values; this round's explicit scope was the two HIGH findings plus the
  two MEDIUM schema findings (malformed `schema_meta`, index-definition
  validation) — the message-content concern was left unchanged pending
  explicit instruction.
- `EXPECTED_TABLES` remains hand-kept in sync with `SCHEMA_DDL` (unchanged
  from Round 2's noted limitation — no schema-derivation framework, by
  design).
- Index validation checks column sequence and the `unique` flag; it does not
  re-verify partial-index `WHERE` clauses or collation (none are used by any
  Factory index).
- All prior TASK-001/TASK-002 limitations still apply unchanged
  (single-writer mutex, no migration runner, local-file-only, `node:sqlite`
  still experimental upstream).

### 11. Ready for independent re-review: YES

## Verification output
Pending — an independent verification pass should re-run `npm run verify &&
npm run demo && npm run demo:persistent` from a clean checkout.

## Reviewer output

Independent persistence review (Codex, 2026-08-19): **CHANGES_REQUIRED**.

### HIGH — incomplete/corrupt schema can masquerade as schema version 1 and remove append-only protection

`ensureSchema()` uses `CREATE TABLE IF NOT EXISTS` and verifies only the
`schema_meta.schema_version` value; it never verifies the existing table
definitions, keys, or constraints before preparing/using them. Reproduction
against a temporary SQLite file: initialize a valid store, replace `evidence`
with `CREATE TABLE evidence (id TEXT, work_item_id TEXT NOT NULL, data TEXT
NOT NULL) STRICT`, then reopen the store. Open succeeds and two writes with
the same Evidence id both succeed (`listByWorkItem` returns two rows). This
violates TASK-002's append-only requirement and the explicit requirement that
a partially initialized schema cannot masquerade as valid. A database whose
marker says an incompatible version is also modified with the current DDL
before `SchemaVersionError` is thrown.

Remediation: validate the full expected schema (including primary keys and
required columns/indexes) before use; refuse any mismatch before mutating a
version-mismatched database. Make fresh-schema creation/version stamping one
safe, atomic initialization path.

### HIGH — deserialization accepts invalid persisted domain state and indexed/data divergence

The parsers check JSON shape and enum membership but do not validate row
metadata against serialized state or all domain lifecycle/value invariants.
Reproduction against a temporary SQLite file: set
`work_items.version = 77` while its JSON `data.version = -1`; reopening and
`findById()` succeeds and returns version `-1`, rather than throwing
`PERSISTENCE_CORRUPTION`. Likewise, adding `finishedAt` to the JSON for a
`RUNNING` Run is accepted and returned. Neither `work_items.version` nor
`runs.status` is selected/compared to serialized state, and WorkItem versions
are accepted as arbitrary finite numbers. This fails the TASK-002 requirement
to explicitly reject corrupted/incompatible data, invalid versions, and
invalid Run lifecycle state; it can inject untrusted audit/workflow state into
`FactoryService`.

Remediation: select and cross-check identity/query/CAS/lifecycle columns
against decoded JSON, enforce WorkItem version constraints, and validate the
complete Run lifecycle shape before returning a record. Any discrepancy must
throw `PersistenceCorruptionError` without repairing or continuing from it.

All required automated checks passed on Node v22.23.1: `npm run typecheck`,
`npm run build`, `npm test` (16 test files, 0 failures), `npm run demo` (DONE,
15 refusals), and two separate `npm run demo:persistent` invocations (seed,
then restart readback without re-seeding). Focused SQL checks also confirmed
rollback/no residue for stale-CAS run attachment, invalid Run finalization,
and multi-write append-only failure; normal two-store contention was safely
refused as `SQLITE_BUSY` and succeeded after the first transaction committed.

### Round 2 independent persistence re-review (Codex, 2026-08-19): **CHANGES_REQUIRED**

The two original HIGH findings are closed: a same-version `evidence` table
without its primary key now fails with `SCHEMA_INTEGRITY_VIOLATION` and is not
repaired; direct SQL/JSON disagreement for Project, WorkItem, Criterion, Run,
Review, Evidence, Verification, and Approval now consistently fails with
`PERSISTENCE_CORRUPTION`. Persisted invalid WorkItem version/lifecycle and Run
lifecycle cases are also refused.

### HIGH — failed incompatible opens still modify the target database

`ensureSchema()` executes `PRAGMA journal_mode = WAL` before distinguishing a
fresh database from a version-mismatched or malformed one. Reproduction using
a temporary database containing only `schema_meta.schema_version = 999`:
opening throws `SCHEMA_VERSION_MISMATCH`, no tables/rows change, but the
persisted journal mode changes from `delete` to `wal`. This violates the
re-review requirement that a failed open/validation leave the database
unmodified.

Remediation: perform all existing-database classification, version checks,
and structural validation before any persistent PRAGMA/DDL; close the newly
opened connection on refusal. Set WAL only after successful validation (or on
the confirmed fresh-initialization path).

### HIGH — an unrelated nonempty SQLite database is treated as fresh and altered

The "fresh" branch checks only for Factory-named tables. A temporary SQLite
database containing an unrelated `user_records` table and data, but no
Factory table, opened successfully and acquired all Factory tables plus a
schema marker. This violates the required distinction between a genuinely
new/empty database and an existing database, and can alter user data stores
passed as the SQLite path.

Remediation: before fresh initialization, verify that `sqlite_master` has no
non-internal user schema objects; otherwise refuse with
`SchemaIntegrityError` without any persistent change. Add a regression test
covering an unrelated nonempty SQLite file.

### MEDIUM — structural/error validation remains incomplete

`schema_meta` missing its `value` column fails with raw `ERR_SQLITE_ERROR`,
not `SchemaIntegrityError`, because it is queried before shape validation.
Also, validation accepts `idx_evidence_work_item_id` when that same-named
index is recreated on `evidence(id)` rather than `work_item_id`; only index
name/table presence is checked. Finally, several corruption messages include
`JSON.stringify` of arbitrary values read from storage. Validate
`schema_meta` before querying it, validate each index's columns, and report
record/table context without echoing stored payloads.

Reviewer verification on Node v22.23.1: `npm run typecheck`, `npm run build`,
`npm test` (17 test files, 0 failures), standalone
`node --test dist/tests/persistenceCorruption.test.js`, `npm run demo` (DONE,
15 refusals), and two `npm run demo:persistent` processes (seed then
readback) all passed. Focused temporary-file probes confirmed atomic rollback,
stale-CAS preservation, terminal-Run refusal, two-store `SQLITE_BUSY` safety,
and cleanup of tracked test database directories.

### Round 3 final focused independent re-review (Codex, 2026-08-19): **PASS_WITH_NON_BLOCKING_NOTES**

All four Round-2 blockers are closed and independently reproduced as fixed:

- An unsupported-version Factory database left `DELETE` journal mode,
  `sqlite_master`, and application rows unchanged before
  `SchemaVersionError`.
- A nonempty unrelated database containing a table, and separate probes with
  an index, trigger, or view, were refused with `SchemaIntegrityError`; no
  Factory schema objects or marker were created.
- Malformed `schema_meta` shape, missing/duplicate version rows, and invalid
  version values were classified as `SchemaIntegrityError` before version
  use, without raw SQLite schema-query errors or repair.
- Same-name indexes with wrong columns, swapped composite order, missing
  definitions, or wrong uniqueness were rejected with `SchemaIntegrityError`.

Read-only classification now precedes all persistent PRAGMAs/DDL; only EMPTY
databases initialize, and CURRENT_FACTORY databases enable WAL after complete
validation. Round-2 SQL/JSON cross-checks and persisted WorkItem/Run lifecycle
validation remain green. Normal restart, transactions, rollback, CAS,
append-only records, workflow continuation, and all TASK-001 regression suites
remain green.

### Non-blocking note (MEDIUM/LOW)

Some `PersistenceCorruptionError` messages include `JSON.stringify` of an
invalid persisted field (for example an invalid enum value). A focused probe
confirmed that an arbitrary token stored in a corrupt Evidence `kind` appears
in the thrown message. No automatic logging or new persistence of secrets was
observed, so this is not a TASK-002 acceptance blocker; future cleanup should
use table/record/field context without echoing arbitrary stored payloads.

Final verification on Node v22.23.1:

- `npm run typecheck` — PASS
- `npm run build` — PASS
- `npm test` — 260 tests, 260 pass, 0 fail (18 test files)
- `node --test dist/tests/persistenceSchemaOpening.test.js` — PASS
- `node --test dist/tests/persistenceCorruption.test.js` — PASS
- `npm run demo` — DONE with 15 refusals
- `npm run demo:persistent` — first process seeded and reopened; second
  process read DONE state without re-seeding
- `git diff --check` — PASS
- `git status --short` — inspected; temporary test directories cleaned

TASK-002 is safe for human acceptance and commit.

## Human decision
Pending.
