# TASK-017 — CLEAN_ROOM_CI

**Roadmap item:** `CLEAN_ROOM_CI` — "Strategic clean-environment CI within the
included allowance". Work class `NORMAL_IMPLEMENTATION`.

**Eligible because** its prerequisite `GITHUB_ORCHESTRATION` (TASK-016) is
accepted and integrated on `main` at `665bc35`.

## What the survey found, and why it decides the shape

Six facts from the tree as it stands, not from a desired design.

1. **There are no workflows at all.** `.github/` does not exist. So this task
   introduces the first one, and every statement below about "the workflow" is
   a statement about a file this task creates rather than one it edits.

2. **`npm test` IS the verification.** `package.json` defines `test` as
   `node scripts/verify.mjs`, and that script is the 1,748-line harness whose
   integrity TASK-010 spent nineteen review rounds establishing. CI must run
   THAT, not a reimplementation — a second definition of "verified" is the
   defect this task must not introduce.

3. **The dependency surface is almost nothing.** Zero runtime dependencies;
   `@types/node` and `typescript` in devDependencies; a 1,558-byte lockfile.
   A clean install is cheap, which removes the usual excuse for caching — and
   caching is a way for CI's tree to differ from a fresh one.

4. **`engines` requires Node >= 22.5.0, and nothing pins a version.** There is
   no `.nvmrc` and no `packageManager` field. So the Node version CI uses is
   currently whatever a runner image happens to ship, which is not a decision
   anybody has made.

5. **The liability report will change, and must say so.** TASK-016's
   `describePushLiability` closes `existing-workflows` only while the
   repository's workflow count is zero, and `introduced-workflows` only while
   the candidate adds none. After this task the first is non-zero permanently,
   and for THIS candidate the second is true. Nothing changes operationally —
   `github-app-subscriptions` never closes, so every remote write still refuses
   — but the report is evidence a human reads, and a channel that quietly kept
   reading "closed" would be lying.

6. **The Factory does not open pull requests, by owner decision.** TASK-016's
   amended AC-5 settled it: a human publishes, and the Factory ADOPTS a pull
   request bound to the exact candidate commit. So CI must fire on the events a
   HUMAN's pull request raises. A workflow that only ran when the Factory
   itself opened a PR would never run.

## The invariant that must not move

CI produces EVIDENCE. It does not produce acceptance. `checkIntegrationReadiness`
already requires both bound passing checks AND an accepted independent review,
and this task supplies one half of that pair. Nothing here may make a green
check sufficient, and nothing here may make the review optional.

## Acceptance criteria (FROZEN — may not be edited to fit the implementation)

**AC-1.** CI runs only on runners GitHub does not meter for this repository.
The workflow names a standard `ubuntu-latest` runner; any larger-runner label is
refused by a checked-in test that PARSES the workflow file rather than trusting
a convention. Proven by mutation: changing the label to a larger-runner label
fails a test that names it.

**AC-2.** The Node version is a decision, not an accident. The workflow pins a
Node version explicitly, and a test asserts that the pinned version satisfies
the `engines.node` range in `package.json` — so the two cannot drift apart
silently. Proven by mutation: a pin below the engines floor fails a test that
names it.

**AC-3.** The clean room is clean BY CONSTRUCTION. The job starts from a fresh
checkout, installs from the lockfile with `npm ci` (never `npm install`), and
inherits no `node_modules`, no build output and no repository-local git
configuration. A test asserts the install command, because `npm install` may
silently resolve differently than the lockfile records.

**AC-4.** The verification CI runs is the verification developers run: the
workflow invokes the repository's own `npm test`, and a test asserts it does not
invoke `node --test`, `tsc` or any other verification path directly. A second
definition of "verified" is the defect this criterion exists to prevent.

**AC-5.** The workflow triggers on the events a HUMAN-created pull request
raises, and on pushes to branches candidates live on. Proven by a test that
reads the trigger list, so a later narrowing that would silently stop producing
evidence fails visibly.

**AC-6.** Every action the workflow uses is pinned to an immutable commit SHA,
not to a tag or branch. A test asserts that every `uses:` value names a
40-character commit id. Tags move; what runs in the clean room must not change
without a code change.

**AC-7.** The workflow holds no secret and asks for no write. It declares an
explicit least-privilege `permissions` block, and a test asserts that no
`secrets.` reference appears anywhere in it and that no permission beyond
reading repository contents is granted.

**AC-8.** A CI pass is not an acceptance. `checkIntegrationReadiness` still
requires an accepted independent review alongside bound passing checks. Proven
by mutation: making green checks sufficient fails an existing test.

**AC-9.** The liability report tells the truth once workflows exist. A test
asserts that an observation reporting a non-zero workflow count leaves
`existing-workflows` OPEN, and that a candidate adding workflow files leaves
`introduced-workflows` OPEN — because a channel that read "closed" after this
task would misinform the human it exists to inform.

**AC-10.** L-10 and L-11 are addressed HONESTLY rather than declared closed.
Both entries state precisely what a clean room does and does not remove: a
fresh checkout on a runner has no external mount and no pre-existing
`node_modules`, so those attacks do not apply THERE; local runs are unchanged,
and the entries say so. No entry claims a limitation is closed that is merely
absent from one environment.

**AC-11.** Every existing guard remains load-bearing, proven by mutation, with
the harness reporting zero survivors and zero unmeasured mutations.

**AC-12.** No test requires network access, a real GitHub Actions run, the real
`gh`, or anything installed on the host beyond Node itself. Offline, like
everything else here. The workflow's correctness is asserted by parsing the
file it ships; whether GitHub then runs it is evidence that arrives after
integration and is reported, never assumed.

## Out of scope

- Autonomous merge on green. Integration remains ADR-0002's path.
- Matrix builds, caching, and performance work. Each adds a way for CI to
  differ from a local run, and none is needed to make the evidence trustworthy.
- Re-opening TASK-016's remote-write verdict or the App-installation residual
  the owner declined to accept.
- Making the Factory open pull requests. That boundary is HUMAN_REQUIRED by
  owner decision, not a limitation awaiting removal.
- Fixing `verificationHarnessEndToEnd`'s duration. It is queued as its own work;
  a slow suite is not this task's defect to absorb.

## Verification plan

- `npm test` at the candidate, green, with counts reported.
- A mutation harness covering every criterion that says "proven by mutation",
  with byte-for-byte restoration verified against run-start hashes.
- An independent acceptance review by a different model, against these criteria
  frozen at this commit, with the tree fingerprinted before and after.
