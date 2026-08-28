# TASK-013 — Clean-room verification boundary

**Status:** SPECIFIED, not started. Created by the round-19 architectural
boundary decision.

## Why this task exists

`scripts/verify.mjs` cannot close the class of defect recorded in L-11:
code from outside the audited tree reaching the verification run. Five
consecutive independent review rounds demonstrated it from five directions —
`src/dist`, a nested `node_modules`, the root install, a symlinked `.git`, and
finally a bind-mounted `.git` directory that produced `HARNESS-EXIT=0`,
`tree-consistent`, and an external execution marker.

The reason is structural, not a missing guard. A bind mount IS the path it is
mounted at: `isSymlink` says no, link counts say no, `realpath` resolves inside
the repository, and on the same device the device-number comparison says no
either. The mount table is the only witness, and the verifier reads it from
inside the very environment under audit — an environment whose mount namespace,
`/proc` and `node` binary an adversary at that level already controls.

Each narrowing round also cost legitimate layouts. `git clone --local` is
refused today. One round refused every `git worktree` in this repository,
including the one the independent reviews themselves run in. That is the failure
mode where a guard gets disabled rather than obeyed, and it is the signal that
the property is being enforced in the wrong place.

## The split

- `scripts/verify.mjs` — deterministic, fail-closed verification WITHIN its
  documented threat model. Unchanged in scope by this task.
- **TASK-013** — a fresh, frozen environment established BEFORE the audited code
  has any say, which is what closes L-11's class.

## Scope: LOCAL clean room, deliberately

This task specifies a local clean-room verification: a fresh checkout and a
fresh dependency install in a directory the working tree does not control,
running the same deterministic verification.

It is scoped this way because it is DEPENDENCY-SAFE. The roadmap's
`CLEAN_ROOM_CI` item is GitHub-based CI ("within the included allowance") and
depends on `GITHUB_ORCHESTRATION`, which depends on `EXECUTOR_WIRING`. Waiting
for that chain would leave L-11 open for the whole of it, and starting it early
would violate a declared dependency. A local clean room needs neither, delivers
the same boundary for this class, and remains the natural foundation for the
GitHub-based item when its turn comes.

**The roadmap catalog is NOT edited by this task.** Changing a `dependsOn` in
`DEFAULT_ROADMAP` alters one of TASK-012's frozen definition fields, and
`reconcileRoadmapWithCatalog` refuses any persisted row that differs from the
catalog — which is exactly L-1, and would make existing supervisor state
unreadable. Reordering the roadmap is a separate planning decision that needs
the L-1 compatibility work first, and it is recorded here rather than performed.

## Acceptance criteria (FROZEN — may not be edited to fit the implementation)

**AC-1.** Verification can be run against a checkout materialised from committed
objects into a directory outside the working tree, with dependencies installed
fresh in that directory. No file in the working tree is read by the verified run.

**AC-2.** The clean-room run reproduces L-11's reproduction and REFUSES it:
with a bind-mounted `.git` supplying an external `.cjs` that a source test
imports, the clean-room result is a failure, not `HARNESS-EXIT=0`.

Three conditions, because "the result is a failure" alone is satisfiable by a
setup that merely broke:

  1. the external execution marker is ABSENT afterwards — the payload did not
     run on the way to the decision;
  2. the failure names the reason, not merely a non-zero exit;
  3. a CLEAN control, identical but for the planted payload, SUCCEEDS in the same
     clean room and reports the same test count as an ordinary run.

The reproduction is executed, not argued.

**AC-3.** A tree that verifies normally also verifies in the clean room, and the
reported test count is identical. A clean room that changes the result on a good
tree is measuring something other than the tree.

**AC-4.** The clean room fails closed: if the checkout, the install, or the
verification cannot be completed, the result is a failure naming which step
failed. An incomplete clean-room run is never reported as a pass.

**AC-5.** No existing guard in `scripts/verify.mjs` is weakened, removed or
made conditional on the clean room existing.

FROZEN INVENTORY. "Every guard listed in the round 15–19 evidence" is not a
checkable set, and read literally it would require restoring the `.git` hardlink
scan that round 19 removed on evidence — a criterion contradicting the branch
that wrote it.

The first version of this inventory was assembled from the implementer's memory
and was WRONG about one entry, which round-21 review demonstrated by running it:
disabling `excludedFromSourceScan` entirely left the `src/dist` case passing,
because the stricter `findHardlinkedSources` scan caught the hardlink anyway.
The table below is the reviewer's measurement, not the author's recollection.

INDIVIDUALLY PINNED — removing the guard alone must fail the named case, with
the other cases still passing:

  1. root-`node_modules` hardlink scan — "REFUSES a hardlinked payload inside
     the root node_modules"
  2. symlinked-`.git` refusal — "REFUSES a symlinked .git"
  3. `findHardlinkedSources` scanning every regular file under the derived roots
     — "REFUSES a hardlinked file under src/dist, which is not the build output"
  4. `excludedFromSourceScan` identity exclusion — "passes with a symlinked
     node_modules when the root is the repository". Removing it does NOT fail the
     `src/dist` case; it makes ORDINARY trees refuse, so the control is what
     detects it. This is the entry the first inventory got wrong.
  5. compiler-input and ancestor mount check — "REFUSES a bind mount over an
     imported directory outside every derived root"
  6. pre-build irregular-entry check — "REFUSES a FIFO planted under the output
     directory"
  7. post-build irregular-entry check — "REFUSES a FIFO the BUILD creates, at
     the after-building stage"
  8. pre-build `linkedCompilerInputs` call — "refuses a symlinked compiler input
     BEFORE building, not after"
  9. post-build readability assertion — "reports an unreadable output directory
     created BY the build at the after-building stage"
  10. early mount-table completeness guard — "REFUSES an unparseable mount table,
      and does so before the build runs"

NOT INDIVIDUALLY PINNED, and this criterion does not pretend otherwise. Each is
a pair whose members mask each other, so no single removal fails anything:

  - the POST-build `linkedCompilerInputs` call. Removing it alone leaves the
    pre-build case green.
  - the pre-build and post-build symlink scans for non-compiler inputs.
    "REFUSES a symlinked non-source file under a source root" fails only when
    BOTH are removed.

Those are recorded in docs/KNOWN-LIMITATIONS.md L-8, which exists for exactly
this. A criterion claiming to pin them would be the same defect one level up —
an assertion satisfied by something other than what it names.

EXPLICITLY OUT OF SCOPE: the `.git` hardlink scan, removed in round 19 because
`git clone --local` and `git submodule` raise a repository's own object link
counts, so it refused ordinary trees for a third party's action. Restoring it is
not required and would reintroduce that defect.

VERIFICATION METHOD, frozen: for each pinned entry, remove the guard from a
disposable copy, confirm the mutation LANDED (mutated text present and original
absent), build, and confirm the named case fails while the others still pass. A
mutation that does not compile, or does not land, proves nothing.

**AC-6.** The clean room does not require a network beyond the dependency
install, does not require sudo, and does not require a paid service.
`AUTONOMOUS_SPEND_LIMIT = 0` applies.

**AC-7.** L-11 is updated to record what the clean room closes and what remains
open, with the same honesty required of every other entry. A limitation that
silently disappears is a limitation nobody knows about.

## Out of scope

- GitHub Actions CI. That is `CLEAN_ROOM_CI`, downstream of
  `GITHUB_ORCHESTRATION`.
- Any change to the roadmap catalog's definition fields (see above).
- Sandboxing the executor's network egress (L-3), which is a different boundary
  needing an OS-level control a human installs.
