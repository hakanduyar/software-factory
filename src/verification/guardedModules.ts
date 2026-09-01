/**
 * Which modules may not lose the tests that guard them (TASK-017).
 *
 * WHY THIS IS A MODULE AND NOT A LIST INSIDE THE VERIFIER (round-8 review,
 * HIGH 4). The list lived in `scripts/verify.mjs` and its tests asserted the
 * verifier's SOURCE TEXT with `includes`. So commenting every entry out left the
 * text present, the tests passing, and the runtime manifest empty — after which
 * deleting a guarded test went unnoticed. A test that reads source text is
 * checking that somebody typed something, not that anything happens.
 *
 * Both the verifier and the tests now import THIS, so the tests examine the
 * same values the verifier enforces and a commented-out entry disappears from
 * both at once.
 *
 * WHAT A PAIR MEANS. If the MODULE is present, its TEST must be present, must be
 * compiled, and must MENTION the module — a test that never names what it
 * guards is a label rather than a guard, which round 6 demonstrated by
 * relabelling one. An ANCHOR names a third file whose presence makes the pair
 * mandatory even when the module is gone, because round 7 removed a module and
 * its test together and left the shipped workflow completely unvalidated.
 *
 * WHAT THIS IS NOT. It makes a test PRESENT, never HONEST. A file emptied of its
 * assertions satisfies every rule here. Mutation and independent review cover
 * that, and a list of filenames does not pretend to.
 */

export interface GuardedModule {
  /** The module whose presence requires the guard. */
  readonly module: string;
  /** The test that guards it. */
  readonly test: string;
  /** Text the test must contain, so a pair cannot be satisfied by relabelling. */
  readonly marker: string;
  /**
   * A file whose presence makes this pair mandatory even if the module is
   * absent — for the workflow policy, the workflow it validates.
   */
  readonly anchor?: string;
}

export const GUARDED_MODULES: readonly GuardedModule[] = [
  {
    module: "src/verification/workflowPolicy.ts",
    test: "tests/workflowPolicy.test.ts",
    marker: "workflowPolicy",
    anchor: ".github/workflows/verify.yml",
  },
  /**
   * The document reader is guarded separately from the policy that consumes it.
   * They were one file until the parser replacement, and the reason they are
   * two is that a reader which decides what the file SAYS and a policy which
   * decides what it may MEAN fail in different ways and are worth losing
   * separately.
   */
  {
    module: "src/verification/workflowDocument.ts",
    test: "tests/workflowPolicy.test.ts",
    marker: "workflowDocument",
    anchor: ".github/workflows/verify.yml",
  },
  {
    module: "src/verification/workflowDigest.ts",
    test: "tests/workflowDigest.test.ts",
    marker: "workflowDigest",
    anchor: ".github/workflows/verify.yml",
  },
  {
    module: "docs/KNOWN-LIMITATIONS.md",
    test: "tests/knownLimitationsHonesty.test.ts",
    marker: "KNOWN-LIMITATIONS",
  },
  {
    module: "src/supervision/financialSafety.ts",
    test: "tests/pushAuthorization.test.ts",
    marker: "financialSafety",
  },
  {
    module: "src/adapters/github/ghCliClient.ts",
    test: "tests/githubCredentialBoundary.test.ts",
    marker: "ghCliClient",
  },
  {
    module: "src/github/candidateBinding.ts",
    test: "tests/candidateBinding.test.ts",
    marker: "candidateBinding",
  },
  {
    module: "src/github/publishCandidate.ts",
    test: "tests/publishCandidate.test.ts",
    marker: "publishCandidate",
  },
  // Two tests may guard one module; each pair is checked on its own.
  {
    module: "src/supervision/financialSafety.ts",
    test: "tests/financialSafetyGate.test.ts",
    marker: "financialSafety",
  },
  {
    module: "src/adapters/supervision/isolatedExecutor.ts",
    test: "tests/executorIsolation.test.ts",
    marker: "isolatedExecutor",
  },
];
