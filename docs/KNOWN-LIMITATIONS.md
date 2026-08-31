# Known limitations

Things this system does NOT do, recorded where an operator will find them.

A limitation that lives only in a review transcript is a limitation nobody knows
about. Each entry says what is not covered, why it is not covered, what would
close it, and how it is prevented from being forgotten.

This register exists because the opposite failure — overstating what a control
achieves — has been the single most repeated defect in this project's review
history. Several entries below were written after a reviewer caught exactly that.

---

## L-1 — Supervisor state is not forward-compatible across schema additions

**Status:** OPEN. Found in operation 2026-08-24, during cross-machine handoff.

Adding a value to a persisted enum makes durable state unreadable by any build
that predates the addition.

Concretely: TASK-009 adds `PLATFORM_CAPABILITY_BLOCKED` to `ESCALATION_REASONS`
and records a blocker with it. The database then contains a value that only a
build carrying TASK-009 can parse. A build from `main` — which does not yet have
TASK-009 — refuses the whole state file:

```
supervisor state.escalations[0]: field "reason" must be one of ..., got "PLATFORM_CAPABILITY_BLOCKED"
```

**This is correct fail-closed behaviour and should not be "fixed" by making the
parser lenient.** An unrecognised value in security-relevant state must not be
silently ignored or coerced — that is the rule every TASK-006 review round
reinforced. The defect is not the refusal; it is that:

1. durable state is coupled to *which branch is built*, so switching branches or
   rolling back a deployment can leave the supervisor unable to read its own
   database;
2. the failure surfaces as a total refusal to start rather than as a specific,
   actionable message about a version mismatch;
3. there is no schema version on the state blob that would let a build say "this
   was written by something newer than me" instead of "this row is corrupt" —
   which are very different problems with very different remedies.

**Why it is recorded here rather than fixed now:** it was found while a frozen
independent review was running, and it will *appear* to resolve the moment
TASK-009 integrates into `main` — which is exactly how a real defect gets lost.
The underlying coupling survives that integration and will recur on the next
enum addition.

**What would close it:** a schema/compatibility version on the persisted state,
so a build can distinguish "written by a newer version" (refuse, and say so
clearly, with the version that wrote it) from "genuinely corrupt" (refuse, and
say that instead). Candidate work for `STATE_INTEGRITY`, which already owns the
durability of this file.

**Workaround today:** delete `.factory/supervisor.db` and re-run
`sf supervise tick` to re-seed from `DEFAULT_ROADMAP`, then re-record any
blocker. Nothing of value is lost — the roadmap definition lives in source — but
recorded blockers and escalation history are.

---

## L-2 — The verifier does not defend against a concurrent local adversary

**Status:** ACCEPTED BOUNDARY. Adjudicated legitimate by independent review
(TASK-010 round 4).

`scripts/verify.mjs` defends against accidental contamination and
misconfiguration: stale build output from another branch, a redirected or
inherited `outDir`, `noEmit`, symlinks and hardlinks pulling in outside code, a
bind-mounted output directory, and a run that would report success having
executed nothing.

It does **not** defend against an adversary with concurrent write access to the
working tree, or control of `PATH`, during the run. Two such escapes were
demonstrated: swapping `tests/` between the check and the build, and shadowing
`npx` so nothing compiled while the stale checker's mtime was touched.

**Why it is not closed:** such an adversary can already edit `src/`, replace
`node`, or rewrite the verifier itself. No verifier running inside the tree it
audits can defend against that, and building something that appears to would
manufacture assurance without substance.

**What would close it:** running verification in a clean checkout in an isolated
environment — the `CLEAN_ROOM_CI` roadmap item.

**Kept honest by:** the boundary is stated in `scripts/verify.mjs` and pinned by
a test asserting that statement is present, so it cannot quietly disappear.

---

## L-3 — The executor's process is not a network sandbox

**Status:** NARROWED by TASK-011 (`feat/executor-isolation`, `e3fe829`),
IMPLEMENTED and AWAITING INDEPENDENT REVIEW. The original in-process form was
adjudicated a legitimate boundary by independent review (TASK-006 round 7).

**What it used to say:** the financial gate authorises a LAUNCH and cannot
police what trusted in-process executor code does afterwards, because an
in-process function cannot restrain code that can already call `fetch`.

**What changed:** the executor now runs in a separate process with an explicit
environment, a bounded request, a timeout, and strict parsing of everything it
returns. It holds no credential store, and the response format has no field
through which a child could grant itself authority.

**What is STILL open, and is the reason this entry survives rather than being
deleted:** raw network egress is **not blocked**. A child can still open a
socket. Closing that needs an OS-level control — a network namespace, seccomp,
or a firewall rule — and installing one needs a sudo password, which ADR-0002
reserves to the human. Autonomous work cannot acquire it.

**What is genuinely removed is BILLING capability**, which is the property
`AUTONOMOUS_SPEND_LIMIT = 0` actually rests on: provider CLIs authenticate from
credential stores under `HOME`/`CODEX_HOME`/`XDG_*`, the isolated allowlist
omits all of them, and a process that cannot authenticate cannot cause a charge
whether or not it can reach the network. A child reaching an unauthenticated
endpoint is a real but much smaller problem than one that can spend money.

**Consequence for the design:** the isolated child performs deterministic work
only. An AI launch needs exactly the credential access it is denied, so launches
stay with the supervisor behind the gate that authorises them — a deliberate
division, not a missing feature.

**Kept honest by:** `EXECUTOR_WIRING` depends on `EXECUTOR_ISOLATION`, and a test
asserts that dependency. A second test reads the implementation source and fails
if it ever claims to be sandboxed, or claims egress is blocked.

**Watch for:** anyone merging the executor allowlist with the WORKER allowlist
"for tidiness". The difference between those two lists IS this control; a worker
is given `HOME` on purpose, and an executor must not be.

---

## L-4 — Implementer lineage is tamper-evident, not tamper-proof

**Status:** NARROWED by TASK-008 and again by TASK-012
(`feat/state-integrity-rebased`, `b207ded`), IMPLEMENTED and AWAITING
INDEPENDENT REVIEW. Adjudicated a legitimate boundary by independent review in
its original form (TASK-006 round 10).

Lineage is a recorded historical fact living in a database, and there is no key
on this machine to authenticate it. Catalog recognition, a cross-check against
`lastRunConfig`, and fail-closed handling of anything CONTRADICTORY raise the
cost of forgery; none of them make the record self-proving.

"Anything missing" was the wording here until round 10, and it was an
overstatement. Missing lineage fails closed when something else still says work
happened. When every record of it is removed together, nothing is left to
contradict.

**What changed:** there is now a SECOND record — an append-only hash chain
written at the same moment as the mutable row. A row rewritten to name a
different implementer contradicts the chain and the review waits for a human; a
chain that does not verify makes every AI ancestor ambiguous. The database and
its directory are also owner-only now, tightened on every open.

**What is STILL open:** the chain has no secret, so it detects nothing against
someone who recomputes it after editing. It catches the corrupted row, the
partial restore, the hand-edit "just fixing one field" — the realistic cases —
and not a determined forger.

**The gap that USED to be here, now closed (round 9).** An empty chain was
treated as silence rather than contradiction, so deleting the whole chain
returned the system to its pre-TASK-008 behaviour for every item. An independent
review built exactly that state — empty chain, genesis anchor, forged `DONE`
rows — and watched every dependent run.

An exemption an attacker can satisfy is not an exemption. A `DONE` item whose
class requires AI, with nothing in the chain saying anything ran on it, is now
refused. Every roadmap item ships PENDING, so a fresh installation pays nothing
for this; a genuinely pre-TASK-008 database pays one human decision before its
dependents proceed, which is the correct price for an unverifiable history.

**Deleting the ANCHOR is no longer a way out either.** `verifyAgainstAnchor`
accepted an absent anchor as silence, so a reviewer truncated the chain, deleted
the row's memory of the tail implementer, deleted the anchor, and that
implementer went on to review its own work — no digest recomputation required.
An anchor is written with every chain now, so its absence is a contradiction,
and the repository refuses to persist a chain whose anchor disagrees with it.

**What still remains:** the narrower allowance in the reviewer-exclusion path,
where an empty chain is not read as a DISAGREEMENT about who implemented an
ancestor whose class needs no AI. And the deeper limit below, which no amount of
this closes.

**The floor moved in round 11, and the entry that claimed otherwise was wrong.**

Round-10 review deleted an item's implementer history, its `lastRunConfig`, the
provenance chain and the anchor, and the resource that had just reviewed the item
reviewed it again. This entry recorded that as the keyless floor: what remained,
it said, was byte-for-byte a database where the work never happened.

That was an overclaim, and round-11 review said so. `attempts` survives the
deletion. The objection to using it was real — `attempts` is incremented when an
action is CLAIMED, one commit before the launch, so a supervisor killed in that
window would leave it set with no lineage — but the answer was better than the
objection: claim reconciliation ALREADY proves the launch never happened, and can
record it. Attempts that reached a worker are `attempts - unlaunchedAttempts`,
and a worker that ran leaves lineage. The reproduction now fails closed, and a
negative control pins that an ordinary crash before launch still resumes.

What was tried and correctly rejected stays recorded, because the reasoning is
the useful part: `lastSuccessAt` on the resource is written by a successful
PROBE, not only by completed work — an implementation of that check was written
and reverted when three negative controls failed. `detail` is free text.

**The floor now:** deleting the progress counters as well. An attacker who
removes `attempts` along with everything else leaves state that genuinely is
consistent with a database where the work never happened, and no keyless scheme
can tell those apart. That is a narrower limit than this entry used to claim, and
it is the honest one.

**What would actually close it:** a record the database writer cannot reach — a
signature over the chain with a key held elsewhere, or an external witness.
That is `CLEAN_ROOM_CI`, and it is where this belongs.

**What TASK-012 changed, and what it did not:** an item's DEFINITION — `key`,
`title`, `workClass`, `dependsOn`, `order` — no longer comes from the database at
all. It comes from a code-level catalog, and a persisted row that disagrees fails
closed naming the field. That closes two bypasses a database writer had which the
chain could not see, because they forged what an item IS rather than what
happened to it: relabelling an `INDEPENDENT_REVIEW` item `DETERMINISTIC` to skip
review, and writing `DONE` onto an unreviewed item so its dependents proceed.

PROGRESS fields — `status`, `attempts`, implementer history, `lastRunConfig`,
diagnostics — remain mutable and remain in the trusted computing base. The
definition is now out of reach; the record of what happened is not, and that is
the whole of what this entry has always been about.

**The contrast worth remembering:** spending authority has no equivalent
weakness, because F-1 made it impossible to EXPRESS in data — no row can grant
it, so no row has to be trusted. Lineage cannot be built that way. The
DEFINITION now can be, and is: it is no longer stored anywhere an attacker can
reach.

**Consequence:** the supervisor database is part of the trusted computing base.

**Kept honest by:** `EXECUTOR_WIRING` depends on `STATE_INTEGRITY` in
`DEFAULT_ROADMAP`, and `tests/task006RemediationRound10Repro.test.ts` asserts
that dependency, so nothing can be wired to execute autonomous work while this
gap is open.

**Also kept honest by:** `sf supervise status` prints the chain verdict with the
words "tamper-evident, not tamper-proof" beside it, and a test fails if that
wording disappears — so the distinction reaches an operator rather than living
only in a source comment. `tests/task006RemediationRound9Repro.test.ts` still
pins the residual forgery case and now states precisely what narrowed and what
did not.

---

## L-6 — Verification refuses trees containing any hardlinked source

**Status:** OPEN, deliberate. Raised by independent review (TASK-010 round 5) as
a false positive; referred back to the reviewer for a judgement on the
trade-off rather than settled unilaterally by the implementer.

`scripts/verify.mjs` refuses any file whose link count exceeds one under the
source roots it derives from `tsconfig.json`. A hardlink is indistinguishable
from an ordinary file by name, type or `realpath`; link count is the only
ordinary signal, and it cannot tell a hardlink pointing outside the repository
from one pointing inside it.

**The scope is wider than this entry once said, and narrower than the correction
first claimed.** Round-14 review caught an understatement — the text described
only `.ts`/`.mts`/`.cts` files under `tests/` — and round-15 review caught the
overstatement that replaced it.

What `findHardlinkedUnder` walks is every regular file beneath every derived
root, EXCEPT:

- the REPOSITORY-ROOT `node_modules` and `.git`, and everything beneath them.
  Nested copies elsewhere are scanned — `src/vendor/node_modules` is walked like
  any other directory. An earlier version of this entry said both names were
  excluded "at any depth", which round-16 review showed permitted arbitrary code
  execution and round-17 review caught still being written here after the code
  had changed.
- the configured output directory, matched BY RESOLVED PATH, so an equivalent
  spelling is one answer.

The path match is the round-15 fix. The exclusion was by NAME, so `src/dist/`
was skipped as though it were build output, and a hardlinked
`src/dist/data.json` was never scanned — the reviewer planted one and the run
reported `tree-consistent`. A `.json` is not a compiler input, so
`linkedCompilerInputs` did not cover it either and it fell through both guards.
That is the round-11 finding a second time: a skipped directory NAME is not a
safe directory.

`linkedCompilerInputs` additionally covers each file tsc reports as an input,
together with its lexical ancestor directories, including inside the excluded
directories above.

Stating the scope narrowly made the guard look cheaper than it is; stating it as
"every regular file" made it look stronger than it was. The cost below lands on
whatever the real scope is, and that is what a reader weighing the trade-off
needs.

**The cost is real and it lands on valid trees.** A clean checkout copied with
`cp -al` is refused — the reviewer demonstrated it. So, potentially, are
hardlinking backup tools, some container layer implementations, and any workflow
that de-duplicates files across checkouts.

**Why it is still the policy:** the alternative — permitting hardlinks whose
target resolves inside the repository — accepts precisely the case that cannot
be told apart from the dangerous one. `npm test` is the default verification for
every human and agent here, so a rule that is occasionally inconvenient was
preferred to one that is sometimes wrong.

**What would make this reconsiderable:** `CLEAN_ROOM_CI` exists to run
verification in an environment the adversary is not in. Once it does, the local
hardlink rule is defending much less and could reasonably become a warning.

**Watch for:** if this begins refusing ordinary working copies, the cost has
exceeded the benefit and the trade-off should be revisited — not worked around
with a bypass flag. A bypass flag would delete the guard for everyone while
appearing to keep it.

---

## L-5 — Provisional failure signatures are inert

**Status:** OPEN, documented in TASK-006.

Neither installed CLI documents its rate-limit or usage-limit output, so the
signature table entries for those states are marked PROVISIONAL and do not fire.
Real provider failures classify as `UNKNOWN_FAILURE` and take the bounded backoff
ladder.

This is deliberate: inventing a signature that has never been observed would be
the "measured vs assumed" dishonesty this codebase repeatedly removes. The cost
is that the more specific resource states are not currently reachable in
practice.

**What would close it:** observing and recording real rate-limit output from each
provider, then promoting the signature from PROVISIONAL to MEASURED.

---

## L-7 — `declaredActionKinds` is a definition field TASK-012 does not enforce

**Status:** OPEN, deliberate and scoped. Recorded at implementation time
(TASK-012, `feat/state-integrity-rebased`), not discovered later.

TASK-012 moved an item's DEFINITION out of the database: `key`, `title`,
`workClass`, `dependsOn` and `order` come from a code-level catalog, and a
persisted row disagreeing with it fails closed.

`declaredActionKinds` belongs on that list by exactly the same argument — it is a
decision recorded in source, not a fact about progress — and it is NOT checked
against the catalog. Its five siblings are the fields the demonstrated bypasses
used, and TASK-012's acceptance criteria were frozen around them before
implementation began. Widening a frozen scope mid-implementation is what C2
forbids, so the gap is written down instead of quietly closed.

**What it means concretely.** Something able to write the database can add or
remove entries from an item's `declaredActionKinds`, and the pre-launch gate runs
over whatever the row declares:

- ADDING a kind makes the gate stricter, which is the closed direction.
- REMOVING a kind from an AI item skips the pre-launch check for that kind.
- REMOVING every kind from a DETERMINISTIC item does NOT get past the gate:
  deterministic work that declares nothing is refused outright, because work that
  never declared anything can never be asked about.

It confers no authority. The action a worker actually reports is evaluated again
by `evaluateFinancialSafety` against the policy, not against the item, so the
realistic consequence is a lost EARLY refusal — the supervisor launching work it
would have declined to start, and then declining it one step later.

**What would close it:** adding the field to `DEFINITION_FIELDS` in
`src/supervision/roadmapCatalog.ts` and declaring it on the catalog entries that
use it. A small change, and a planning decision rather than an implementer's.

**Kept honest by:** the header comment of `src/supervision/roadmapCatalog.ts`
names this residue and points here, and `tests/roadmapStructuralIntegrity.test.ts`
asserts the naming is present — so deleting the note fails a test.

---

## L-8 — Some guards are unreachable through the public path, and say so

**Status:** OPEN, deliberate. Each instance is stated in its own source file;
this entry exists so the pattern is findable in one place.

Three guards cannot be reached through the interface their callers use, so no
test can prove them load-bearing. Independent review mutated each one and the
suite stayed green — correctly. Rather than deleting them or implying a tested
guarantee, each says plainly what it is:

- `onlyKeys` in `src/supervision/executorProtocol.ts` inspects OWN property names
  including non-enumerable ones. The only entry point takes TEXT, and
  `JSON.parse` cannot produce a non-enumerable own property, so it is
  indistinguishable from `Object.keys` in practice. What actually defends the
  parser is the allowlist, which is tested.
- The catalog rebuild in `src/supervision/roadmapCatalog.ts` returns definition
  fields from the catalog rather than the row. Any row that DIFFERS is refused
  first, so the two can never disagree on a path that returns a value.
- The post-build `assessMountTopology` call in `scripts/verify.mjs` runs after a
  pre-build refusal that already rejects a mounted output.

  The reason given here used to be "creating a mount needs privileges no fixture
  has", and round-16 review showed that is wrong: a same-device bind mount can be
  made in an unprivileged user and mount namespace, and a real test does exactly
  that unskipped. The call is unreachable because the PRE-BUILD refusal fires
  first, which is a claim about ordering rather than about privilege — a weaker
  and more accurate reason than the one it replaces. Its DECISION is proven by the pure tests; the
  call exists so a future reordering still meets a tested guard before anything
  is deleted.

One more joined them in round-13 review of the verification harness, and this one
is a TEST rather than a guard:

- `TASK-010 AC-1`'s end-to-end case cannot distinguish the runner receiving
  `audit.expected` from it receiving `compiledTests`. Replacing one with the
  other leaves it green, which the reviewer demonstrated.

  The reason is structural: the audit must be CLEAN before anything runs, and
  clean means those two lists are equal. On any tree that reaches execution they
  are the same argv, so no observation of the run can tell them apart — including
  the injectable-runner approach the reviewer suggested, which would record
  identical arguments either way.

  What actually enforces AC-1 is the AUDIT, which compares source-derived
  expectations against what is on disk and refuses when they differ; that
  comparison is load-bearing and its removal fails several named regressions.
  The end-to-end case pins that the suite RUNS and reports honestly, not which
  variable was passed, and it is worth saying so rather than leaving a reader to
  assume the stronger claim.

Two more joined them in round 14, and both are recorded here rather than deleted
or dressed up:

- The per-key `chainImplementers === undefined` branch in the reviewer-exclusion
  walk is GONE, replaced by a single assertion. Independent review measured it
  against `brokenChainOutcome` and found the two masking each other — removing
  either left the suite green AT THE TIME.

  **That is no longer true of `brokenChainOutcome`, and this entry said it was
  until round 16.** Once the four tamper modes were driven through real SQLite,
  removing that guard failed all four of them while the clean control kept
  passing. It is load-bearing now, and only the ASSERTION beside it remains
  unreachable. A limitation register that describes a guard as untested after
  the test exists is the same defect it was written to prevent, one level up. They cover the same case because step 0 uses
  `verifyAgainstAnchor`, which is strictly stronger than the structural check
  behind the `undefined`. There is one decision now and an assertion of the
  invariant it establishes, which throws rather than deciding: reaching it would
  mean step 0 is broken, and an internal contradiction must not be mistakable for
  a considered verdict.
- The chain-key traversal's "roadmap no longer contains this key" branch is
  reachable only through the in-memory repository. `parseSupervisorState` refuses
  a chain entry naming an unknown roadmap item, so a real database cannot present
  that state. The branch stays because the two refusals are independent and
  relaxing one should not silently open the other; its test says in its name that
  it is in-memory.

Two more pairs joined them in round 21, and they are PAIRS rather than single
guards — each member masks the other, so no single removal fails anything:

- the POST-build `linkedCompilerInputs` call. Removing it alone leaves the
  pre-build case green, because the pre-build call already refused the tree.
- the pre-build and post-build symlink scans for non-compiler inputs. "REFUSES a
  symlinked non-source file under a source root" fails only when BOTH are
  removed.

Round 22 found three more, measured by me after the reviewer named them: the
pre-build and post-build `findHardlinkedSources` calls mask each other (removing
either leaves the whole harness green); the pre-build output hardlink scan is
covered by other cases but not by the one named for it; and
`assertEverythingWasReadable("before auditing")` can be removed with all 107
harness tests still passing.

That last one is kept rather than deleted, and the inconsistency is deliberate
and stated: its sibling `assertEverythingWasRegular("before auditing")` was
deleted on identical evidence in round 19. Deleting a guard on a mutation result
has gone wrong here before — round 12 produced the case for an ancestor check
removed exactly that way — so the conservative option is taken and the choice is
put to review rather than settled unilaterally.

Measured rather than assumed. They are recorded here rather than claimed as
pinned in TASK-013's AC-5 inventory, because a criterion
asserting they are individually proven would be an assertion satisfied by
something other than what it names — the defect this register exists to catch,
one level up.

**Why they stay:** each GUARD here is defence in depth against a future
reordering, and each costs nothing. The AC-1 entry is not a guard and stays for a
different reason: a test that cannot fail for the reason its name gives should
say so rather than be counted as coverage. **Why this entry exists:** "defence in
depth" is exactly what an untested guard looks like from the outside, and the
difference between the two is a claim someone should be able to check.

**What would close it:** for `onlyKeys`, an entry point accepting an
already-parsed object — which nothing needs. For the catalog rebuild and the
post-build `assessMountTopology` call, a reordering that made them reachable,
which would be a regression rather than a fix. For AC-1, nothing available:
the two lists are equal by construction on every tree that runs, so the
distinction is unobservable rather than merely untested.

**Kept honest by:** a fourth member of this list was found NOT to be unreachable.
The post-build tree-safety wiring in `scripts/verify.mjs` had the same
justification written beside it, and a build that plants its own symlink under
the output directory does reach it — nothing privileged required. It has a test
now. An unreachability claim is a claim like any other, and this one has already
been wrong once.

---

## L-9 — The isolated child can be signalled by anything running as the same user

**Status:** OPEN, deliberate. Raised by independent review (TASK-011) and
recorded here after round-13 review found the source citing an entry that did
not exist.

The isolated executor runs the child in its own process group, closes the
inspector, filters the environment and restricts filesystem access. None of that
constrains a process running as the SAME UNIX USER.

**What that means concretely:**

- Anything running as this user can `SIGKILL` the supervisor while a child is
  mid-run. The child is `detached`, so it survives its parent; the supervisor
  records no outcome, and durable state keeps whatever it last committed. That
  is a denial of service, not a bypass of the financial gate — a real
  limitation, and a smaller one than a child that can spend money.
- Equally, anything running as this user can signal the CHILD. The process group
  makes the supervisor's own timeout kill reach descendants; it does not make
  the group private.
- `setsid` and PID namespaces would narrow this, and both need privileges or
  installation this process does not have and must not acquire for itself.

**Why it is not closed in-process:** a process cannot deny signals to another
process with the same credentials. The boundary is the operating system's, and
moving it needs a different user, a namespace, or a container — an OS-level
control a human installs.

**What would close it:** running the executor as a separate unprivileged user,
or under a PID namespace. That is `CLEAN_ROOM_CI` territory, alongside the
external witness L-4 needs.

**Kept honest by:** `src/adapters/supervision/isolatedExecutor.ts` cites this
entry by number, and a test asserts every limitation the source cites actually
exists in this file — the check that would have caught the missing entry.

---

## L-10 — A `node_modules` that is wholly external is not detected

**Status:** OPEN, deliberate. Raised by fixing round-17's CRITICAL and stated
here rather than left implied by the fix.

Round-17 review demonstrated that an external `.cjs`, hardlinked under the
repository's own `node_modules` or `.git` and required from a source test, RAN
while verification exited 0 and reported `tree-consistent`.

**Half of that is closed and half is not, and this entry said "either" for two
rounds after it stopped being true.** `hardlinksInsideRootInstalls` refuses any
file with `nlink > 1` inside `node_modules`. It does NOT scan `.git`: that scan
made this repository refuse itself once a reviewer's submodule fixture raised
its object link counts, and the reasoning is in L-11. The `.git` hardlink vector
is therefore OPEN and belongs to L-11's class.

**What it still does not see.** Only HARDLINKS are reported. A `node_modules`
that is itself a symlink to an attacker-controlled directory has `nlink == 1`
on every file inside it, and is accepted. So is a symlinked package inside an
ordinary install.

**Why it is not closed:** a shared or symlinked `node_modules` is an ordinary
layout — a shared store, a container volume, a monorepo hoist — and this
repository's own test harness uses one for every fixture. Refusing it would
refuse the common case in order to catch the rare one, and a guard that refuses
ordinary work gets disabled rather than obeyed. Link count cannot tell a
package manager's store from an attacker's directory; both resolve outside the
repository, which is what a store IS.

**The honest boundary:** `node_modules` is third-party code that executes by
design. `npm install` runs lifecycle scripts, and the `typescript` package there
compiles this tree. Anyone able to plant files in it can replace the compiler,
which no scan of its contents would catch. It belongs in the trusted computing
base alongside `node` and `PATH`, which the threat model in `scripts/verify.mjs`
already excludes. The round-17 fix raises the cost of the specific hardlink
route; it does not make the directory trustworthy.

**Measured, because the previous version of this reasoning was asserted and
wrong.** On this repository: 0 hardlinked files in `node_modules` (248 files),
0 in `.git` (997), full scan 12ms. I had defended excluding both on the ground
that scanning "would refuse ordinary repositories" — a cost I never measured and
which is zero here. That claim cost three review rounds and permitted arbitrary
code execution.

**The cost that IS real:** `git clone --local` hardlinks its objects — 888
measured in a local clone of this repository — so a `--local` clone is now
refused. This is the same trade-off L-6 records for `cp -al`, and the same
instruction applies: if it starts refusing ordinary working copies, revisit the
trade-off rather than adding a bypass flag, which would delete the guard for
everyone while appearing to keep it.

**What would close it:** `CLEAN_ROOM_CI` — a fresh checkout and a fresh install
in an environment the adversary is not in. It is the answer for this class, as
it is for the TOCTOU gaps the threat model already records.

**Kept honest by:** `tests/verificationHarnessEndToEnd.test.ts` proves the
hardlink route is refused, including two cases whose assertion is that the
payload's marker file was never written — the run refused it without executing
it. Nothing proves the symlink route is refused, because it is not.

---

## L-11 — A mounted directory can supply code the verifier never audits

**Status:** OPEN, ACCEPTED ARCHITECTURAL BOUNDARY. Found by independent review
(round 19) and classified there as belonging to `CLEAN_ROOM_CI` rather than to
another `scripts/verify.mjs` patch. The scope split was authorised by the human
before this entry was written.

A root `.git` DIRECTORY mounted from an external directory can dynamically
supply `.cjs` code. The reviewer's same-device namespace probe produced
`HARNESS-EXIT=0`, `tree-consistent`, and an external execution marker: the run
executed code from outside the tree and reported the tree consistent.

**Why this is not another guard.** A bind mount IS the path it is mounted at.
`isSymlink` says no, link counts say no, `realpath` resolves inside the
repository, and on the same device even the device-number comparison says no.
The mount table is the only witness, and the verifier reads it from inside the
environment being audited — an environment whose mount namespace, `/proc`, and
`node` binary are all things an adversary at this level already controls. Each
round of narrowing has also cost more legitimate layouts: `git clone --local` is
refused today, and the previous attempt refused every `git worktree` in this
repository, which is the failure mode where a guard gets disabled rather than
obeyed.

**The rule this entry encodes:**

- `scripts/verify.mjs` = deterministic, fail-closed verification WITHIN its
  documented threat model.
- `CLEAN_ROOM_CI` = a fresh, frozen environment that closes the broader class of
  "code from outside the audited tree reaches the run".

**What is NOT weakened.** Every existing guard stays exactly as it is. Nothing
here licenses relaxing the hardlink scan, the mount checks, the symlink
refusals or the `.git` handling because a future clean room will exist. The
boundary moves the CLASS that remains open; it does not reopen what is closed.

**The four rounds that produced this, recorded because the pattern is the
finding:** round 15 `src/dist`, round 16 nested `node_modules`, round 17 the
root install, round 18 the worktree regression. Each fix was correct in
isolation, each was introduced by the fix for the round before it, and each
bought a narrower hole at the price of refusing more legitimate trees. That is
what a boundary looks like from the inside before it is named.

**A `.git` HARDLINK IS NOW ACCEPTED, and the reversal belongs in this entry.**

Round 17 scanned `.git` for hardlinks, on a measurement of 0 hardlinked files.
The measurement was taken at the wrong moment. `git clone --local` and
`git submodule` hardlink a repository's objects, raising the link count on BOTH
sides — so this repository's `.git/objects` became hardlinked because the
round-19 reviewer made a submodule fixture under `/tmp` while reviewing the
branch. Verification then refused its own repository with 902 hardlinked
objects, and would have stayed refused until an unrelated directory elsewhere
was deleted.

A guard that breaks a repository because somebody else cloned it is not a guard.
It was removed for that reason and NOT because a clean room is coming: no guard
here is relaxed on the strength of future work. `node_modules` keeps its scan,
because an install is this project's own business and measures 0 here, whereas
who clones this repository is outside its control. A symlinked `.git` is still
refused — no false positives, no legitimate use.

So the open vector is wider than when this entry was written: a `.git` that is
MOUNTED from elsewhere, or HARDLINKED into, can supply code a source test
imports.

A SYMLINKED `.git` is NOT in that list, and an earlier draft of this sentence
put it there. `refuseSymlinkedGit` rejects it before building and a test asserts
the `.git is a symlink` reason, so listing it as open was false — this register
overstating a danger is the same defect as understating one, and round-21 review
caught it. What remains open is the mount and the hardlink.

**What would close it, and precisely how much:** `TASK-013` — verification in a
fresh checkout and a fresh install, where the mount topology and the toolchain
are established before the audited code has any say.

That closes HOSTILE MATERIALISATION OF THE WORKING TREE: mounts, links and
planted files that make the audited tree misrepresent itself. It does NOT make
the environment trustworthy in general. A fresh `node_modules`, the `node`
binary and `PATH` remain trusted computing base in the clean room exactly as
they are here, and this entry is narrowed to say so — an earlier draft said the
clean room "closes the broader class", which claimed more than a clean room can
deliver.
The roadmap's `CLEAN_ROOM_CI` remains the GitHub-based item downstream of
`GITHUB_ORCHESTRATION`; TASK-013 is the dependency-safe local form of the same
boundary.

**Kept honest by:** `docs/tasks/TASK-013-clean-room-verification.md` records the criteria,
and this entry names the reproduction so nobody has to rediscover it. If a
future change claims to close this class inside `verify.mjs`, that claim needs
the reviewer's probe run against it, not an argument.

## L-12 — The supervisor authorises one AI resource; a plan declares three

**Status:** OPEN, ACCEPTED SCOPE BOUNDARY. Found by independent review of
TASK-014 (round 2, CRITICAL, second half). The gate that closes the dangerous
half is implemented; what remains open is how much legitimate work it can
therefore drive.

`SupervisorService` routes a roadmap item to exactly ONE provider/model/effort.
It probes that resource in-process, puts it through the financial gate, and
records it as provenance. A PLAN carries its own persisted execution
configuration — a planner, an implementer and a reviewer, each with its own tool
and model — and the engineering loop launches those.

Nothing reconciled the two, so a supervisor could authorise `claude-code/opus`,
drive a plan whose implementer is `codex-cli/gpt-5.6-luna`, and record
`claude-code/opus` as what ran. A gate that authorises X while Y executes is
worse than no gate, because it produces evidence that the wrong thing was
checked.

**What is closed.** `checkPlanAuthorization` runs immediately before the launch
and REFUSES any plan whose planner, implementer or reviewer is not exactly the
authorised resource, including its effort. It does not repair the mismatch:
substituting a provider, or re-routing to whatever the plan declares, would be
that layer granting authority it does not have. The refusal is
`HUMAN_REQUIRED / RECONCILE_PLAN_AUTHORIZATION` and it names both sides.

**What is therefore OPEN.** A plan whose reviewer is a different model from its
implementer cannot be driven by this supervisor at all. That is the ordinary
shape, and for critical work it is the shape C4 REQUIRES — the implementer must
not be the sole semantic reviewer. So the supervisor can currently drive only a
plan whose entire AI surface is one resource, which is the least interesting
kind of plan.

**Why it is not closed here.** Closing it means the supervisor authorising a SET
of resources: routing a set, probing each, gating each, recording each in
provenance, and reconciling each reported identity. That is `SupervisorService`'s
design, frozen and accepted under TASK-006, and TASK-014 may not quietly widen it
to make its own work pass — C2 exists for exactly this temptation. The
conservative direction was to refuse and record.

**What is NOT weakened.** The refusal is not softened for the common case, and
the check is not moved earlier where another path could reach the launch around
it. It sits immediately before the launch, which is the only position a
fail-closed gate can hold.

**Kept honest by:** `tests/planAuthorization.test.ts` asserts the refusal for
each role independently — planner, implementer and reviewer each get a case that
leaves the other two matching — and one case asserts this limitation directly. If
that case ever goes green, L-12 is closed and this entry is what has to change.

## L-13 — A plan's roadmap identity (CLOSED — and this entry was WRONG when written)

**Status:** CLOSED. Kept rather than deleted, because its first version claimed a
limitation that does not exist. A register that overstates a danger is the same
defect as one that understates it, and round-21 review already made that point
about a different entry — this is the same mistake, made by me, one task later.

**The claim that was wrong.** The entry said `declaredConstraints` "is not part
of the content digest an approval signs", so anyone with write access to the
plans database could re-point a plan at a different roadmap item. That conflated
two digests. `computePlanContentDigest` covers a REVISION's content and does not
include it — but what an APPROVAL is bound to is `computePlanApprovalDigest`,
which covers `declaredConstraints` explicitly, and `verifyApprovalAuthority`
recomputes it on every authority check and refuses when it no longer matches
`plan.approvedDigest`.

So editing a plan's declared roadmap key after approval INVALIDATES the approval.
The plan is then demoted to `RECOVERY_REQUIRED` by the same re-derivation that
closed round-3 finding 1, and the supervisor refuses to act on it.

**Therefore the binding is semantic, durable AND approval-bound**, which is
strictly more than the entry claimed to deliver. Caught by TASK-015's independent
review, which read the digest code instead of believing the entry. I had reasoned
from a function name without checking which digest an approval actually signs.

The historical description of the defect and its fix follows, because the
reproduction is still worth having.

`--roadmap-plans` maps a roadmap key to a plan id. Round-3 review bound a
perfectly valid approved plan — whose own work item is `WI-A` — under the
unrelated key `LOCAL_24_7_RUNTIME`, and the supervisor resumed it. One mistaken
line in a JSON file executed unrelated approved work, because the plan carried no
roadmap identity at all and so nothing could disagree with the file.

**What is closed.** The declaration is now TWO-SIDED: the operator's file says
which plan serves an item, and the plan must name the item it serves, in
`declaredConstraints`. `checkPlanBinding` refuses a plan that declares a
different key, no key, or more than one, and it runs BEFORE any outcome is
derived — so an unrelated plan's `BLOCKED` cannot be reported as this item's
blocker either.

**Why `declaredConstraints` and not revision constraints.** It is operator input,
and `planTypes.ts` states the rule it lives under — never rewritten by any model.
Revision constraints are planner OUTPUT, and an identity a model can edit during
a re-plan is not an identity. It turns out to be the digest-covered choice as
well, which the entry originally got backwards.

**Kept honest by:** `tests/planBinding.test.ts` asserts the refusal for a
different key, a missing key and two keys, and — the control that matters —
asserts a correctly declared plan is still ACCEPTED, so the guard is not
satisfied by refusing everything.

## L-14 - A push verdict proves what GitHub itself will meter, not that no App can react

`GIT_PUSH` was registered financial with a comment predicting the remedy: "a
push to a target with demonstrated zero liability could earn a minted action
later, the way verification commands did." TASK-016 earns it -- but the FIRST
attempt earned it too cheaply, and the round-1 review was right to refuse it.

**What the first attempt got wrong.** It required only "public repository" and
"zero repository webhooks". GitHub bills LARGER RUNNERS even on public
repositories, and organisation-scoped webhooks are outside a repository query,
so that pair never established zero liability. Converting an incomplete
observation into `costKnownZero` is exactly the declared-not-derived mistake
the financial gate exists to prevent.

**What is required now.** All five, each observed in-process immediately before
the gate, and each failing closed when it cannot be read:

- `visibility` is PUBLIC -- standard runners are not metered there;
- `ownerType` is USER -- a user account cannot have organisation-level webhooks
  at all, and this token cannot enumerate an organisation's, so an
  organisation-owned target is never demonstrable;
- `repositoryWebhooks` is 0 -- no repository-scoped forwarder to a metered
  third party;
- `configuredWorkflows` is 0 -- with no workflows no Actions run can start, so
  runner size cannot bill a run that cannot exist;
- `candidateAddsWorkflows` is false -- and the push must not CREATE that
  possibility, since a push carrying `.github/workflows/*` can trigger the very
  run it introduces, on a runner it chooses.

**The residual, stated narrowly.** A GitHub App installation is NOT observable
with the Factory's credentials: `/repos/:owner/:repo/installation` answers 401
and `/user/installations` answers 403 for an OAuth token. So a push earning
`FREE_REMOTE_ACTION` demonstrates that GitHub itself will not meter it and that
no repository- or organisation-scoped integration exists to forward it -- NOT
that an App subscription a human previously authorised cannot react to it. That
residual cannot create NEW autonomous spend by the Factory; it can only
continue a commitment a human already made.

**Kept honest by:** `tests/pushAuthorization.test.ts` has one case per
mechanism, each satisfying every other condition so that only the named one can
produce the refusal, and -- the control that matters -- one case where all five
hold and the push is PERMITTED, so the guard is not satisfied by refusing
everything.
