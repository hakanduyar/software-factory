# TASK-012 — ROADMAP_STRUCTURAL_INTEGRITY

Roadmap key: `ROADMAP_STRUCTURAL_INTEGRITY`
Status: acceptance criteria FROZEN before implementation (ADR-0002 condition 1).

## Why this is a separate task

TASK-008 protects LINEAGE: who implemented what. Its independent review then
demonstrated two bypasses that lineage protection cannot reach, because they
attack a different thing — the item's own definition:

1. Changing a persisted item's `workClass` from `INDEPENDENT_REVIEW` to
   `DETERMINISTIC` makes the supervisor skip independent review entirely. The
   item is executed and marked DONE, "accepted without independent review".

2. Persisting an `INDEPENDENT_REVIEW` item as `DONE` without any review having
   happened makes its dependents eligible. Dependency truth is derived from
   `status === "DONE"` in the same mutable row.

Neither is a defect in the provenance chain. Both are the consequence of a
design that TASK-008 inherited and did not create: **the roadmap's DEFINITION
is persisted in the same mutable row as its PROGRESS**, so anything that can
write the database can redefine what an item is, not merely lie about who
built it.

Absorbing this into TASK-008 would have meant editing a frozen scope to cover a
different problem. It is tracked separately so the boundary stays visible, and
so TASK-008 is judged against what it promised.

## The distinction this task rests on

A roadmap item has two kinds of field:

- **DEFINITION** — `key`, `title`, `workClass`, `dependsOn`, `order`. These are
  decisions recorded in source (`DEFAULT_ROADMAP`). They do not change because
  work progressed.
- **PROGRESS** — `status`, `attempts`, `implementedByResourceKey(s)`,
  `lastRunConfig`, `detail`, `humanActionRequired`. These are facts about what
  has happened, and they belong in durable state.

Persisting the definition alongside the progress made the definition editable.
The same mistake has now produced findings in three separate rounds, each time
one level further out: a resource row that granted spending, a `workClass` that
decided whether the chain was read, and now a `workClass` that decides whether
review happens at all.

This is the same rule TASK-006 already applies to `ResourceRecord.key` and
`SupervisorActionClaim.actionId`: a derived value is RECOMPUTED on read, never
trusted from the row.

## Acceptance criteria (FROZEN — may not be edited to fit the implementation)

**AC-1.** An item's DEFINITION fields come from a code-level catalog, not from
persisted state. A persisted value that disagrees with the catalog never
determines behaviour.

**AC-2.** A disagreement between the persisted definition and the catalog is
DETECTED and FAILS CLOSED with a message naming the field and the item — it is
not silently corrected, because silent correction hides tampering just as
effectively as accepting it.

**AC-3.** A persisted item whose key is not in the catalog fails closed. An
item this installation cannot recognise is not an item it should execute.

**AC-4.** The catalog is injectable, as `resourceCatalog` already is, so tests
declare their roadmap in code rather than smuggling one through persisted
state. The default is `DEFAULT_ROADMAP`.

**AC-5.** `workClass` cannot be used to skip independent review: an item whose
CATALOG class is `INDEPENDENT_REVIEW` is reviewed as such regardless of what
the row says.

**AC-6.** A `DONE` status on an item whose catalog class requires AI is
cross-checked against provenance. An item marked complete with no record of
anything having run on it fails closed rather than satisfying its dependents.

**AC-7.** `dependsOn` comes from the catalog, so deleting an edge in persisted
state cannot make a dependent eligible.

**AC-8.** The honest limit is stated: this moves the definition out of reach of
a database writer, and does NOT make the database trustworthy. Progress fields
remain mutable and remain the trusted computing base, exactly as TASK-008 says.
A test asserts that statement is present where an implementer will read it.

**AC-9.** Existing behaviour is preserved: the full suite passes, the financial
gate is untouched, and `EXECUTOR_WIRING` still depends on both
`STATE_INTEGRITY` and `EXECUTOR_ISOLATION`.

## Verification plan

- Each bypass reproduced against REAL SQLite exactly as the reviewer drove it:
  relabelled `workClass`, forged `DONE`, deleted `dependsOn` edge, unknown key.
- Mutation testing: every guard removed in turn, confirming its own regression
  fails. Removing the guard, not its input.
- A negative control: a legitimate roadmap must still advance normally, so the
  guards cannot be satisfied by refusing everything.
