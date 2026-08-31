/**
 * `sf github publish` — the SHIPPED construction path for TASK-016.
 *
 * This file is the wiring, and deliberately holds no policy: every decision it
 * reaches for lives in `src/github/` or in the financial gate, where it is
 * tested without a process, a network or a credential. What is here is the part
 * that cannot be unit-tested away — which executable runs, which repository is
 * expected, which policy object is consulted, and what an operator sees.
 *
 * IT PUBLISHES; IT DOES NOT INTEGRATE. There is no merge command, because
 * TASK-016's frozen scope produces the readiness verdict and a later task
 * consumes it.
 */

import { createGhCliClient, createGitPusher, createGitRepositoryReader } from "../adapters/github/ghCliClient.js";
import { createNodeProcessRunner } from "../adapters/process/nodeProcessRunner.js";
import { publishCandidate, type PublishOutcome } from "../github/publishCandidate.js";
import { publicationDetail, withPublicationRecorded } from "../github/publicationProvenance.js";
import {
  checkCheckEvidence,
  checkIntegrationReadiness,
  isCommitSha,
  type ReviewedCandidate,
} from "../github/candidateBinding.js";
import { boundedDiagnostic } from "../supervision/resourceClassifier.js";
import { readLocalState } from "../github/publishCandidate.js";

/**
 * The zero-spend policy this build runs under.
 *
 * Stated as a literal rather than read from the supervisor row on purpose: F-1
 * established that spending authority may never come from persisted data, and
 * this command performs a gated remote write without a supervisor tick around
 * it. `parseFinancialPolicy` still refuses anything that claims authority, so
 * the literal is the honest floor rather than a second source of truth.
 */
const ZERO_SPEND_POLICY = Object.freeze({ autonomousSpendAllowed: false, autonomousSpendLimit: 0 });

export interface GithubPublishArgs {
  readonly roadmapKey: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly headRef: string;
  readonly baseRef: string;
  readonly repository: string;
  readonly remoteUrl: string;
}

/**
 * Parses `sf github publish`, refusing unknown flags and stray positionals —
 * the `parseSuperviseTickArgs` discipline, which exists because inline
 * `indexOf` parsing silently ignored a misspelled flag.
 */
export function parseGithubPublishArgs(
  args: readonly string[],
): { readonly ok: true; readonly value: GithubPublishArgs } | { readonly ok: false; readonly error: string } {
  const values = new Map<string, string>();
  const known = new Set(["--roadmap-key", "--head", "--base", "--head-ref", "--base-ref", "--repo", "--remote-url"]);

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("--")) {
      return { ok: false, error: `unexpected argument ${JSON.stringify(token)}` };
    }
    if (!known.has(token)) {
      return { ok: false, error: `unknown flag ${JSON.stringify(token)}` };
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, error: `${token} requires a value` };
    }
    if (values.has(token)) {
      return { ok: false, error: `${token} was given more than once` };
    }
    values.set(token, value);
    index += 1;
  }

  for (const flag of known) {
    if (!values.has(flag)) {
      return { ok: false, error: `${flag} is required` };
    }
  }
  const headSha = values.get("--head")!;
  const baseSha = values.get("--base")!;
  /**
   * Identity is checked HERE as well as inside the pure checks, so an operator
   * who pastes an abbreviated sha is told immediately rather than after a
   * remote round trip.
   */
  if (!isCommitSha(headSha) || !isCommitSha(baseSha)) {
    return { ok: false, error: "--head and --base must each be a full 40-character commit id" };
  }
  return {
    ok: true,
    value: {
      roadmapKey: values.get("--roadmap-key")!,
      headSha,
      baseSha,
      headRef: values.get("--head-ref")!,
      baseRef: values.get("--base-ref")!,
      repository: values.get("--repo")!,
      remoteUrl: values.get("--remote-url")!,
    },
  };
}

export interface GithubCliOptions {
  readonly log?: (line: string) => void;
  readonly cwd?: string;
  /** Injectable so a test never depends on the wall clock. */
  readonly now?: () => number;
}

/** The same default the supervisor CLI uses; the env override is honoured too. */
const DEFAULT_SUPERVISOR_DB_PATH = ".factory/supervisor.db";

function build(args: GithubPublishArgs, options: GithubCliOptions) {
  const deps = {
    processRunner: createNodeProcessRunner(),
    cwd: options.cwd ?? process.cwd(),
    repository: args.repository,
  };
  return {
    github: createGhCliClient(deps),
    git: createGitRepositoryReader(deps),
    pusher: createGitPusher(deps),
    expectedRepository: args.repository,
    expectedRemoteUrl: args.remoteUrl,
    financialPolicy: ZERO_SPEND_POLICY,
  };
}

function candidateFrom(args: GithubPublishArgs): ReviewedCandidate {
  return {
    roadmapKey: args.roadmapKey,
    headSha: args.headSha,
    baseSha: args.baseSha,
    headRef: args.headRef,
    baseRef: args.baseRef,
  };
}

/** Everything printed goes through the same bounding/redacting chokepoint. */
function safe(value: string): string {
  return boundedDiagnostic(value);
}

export async function runGithubPublish(
  args: GithubPublishArgs,
  options: GithubCliOptions = {},
): Promise<number> {
  const log = options.log ?? ((line: string): void => console.log(line));
  const outcome = await publishCandidate(build(args, options), candidateFrom(args));

  if (outcome.kind === "REFUSED") {
    log(`REFUSED: ${safe(outcome.reason)}`);
    return 1;
  }
  if (outcome.kind === "HUMAN_REQUIRED") {
    // A financial boundary is an expected outcome, not a fault: it exits 0 the
    // way a supervisor tick reporting WAITING_FOR_HUMAN does.
    log(`HUMAN_REQUIRED: ${safe(outcome.reason)}`);
    return 0;
  }
  log(
    `PUBLISHED: pull request #${outcome.pullRequest.number} at ${outcome.pullRequest.headSha} ` +
      `(${outcome.created ? "created" : "adopted"}, ${outcome.pushed ? "pushed" : "already present"})`,
  );
  log(`  record: ${safe(publicationDetail({ pullRequest: outcome.pullRequest, checks: outcome.checks }))}`);

  /**
   * RECORDED DURABLY, and a failure to record is a FAILURE (AC-4).
   *
   * The push already happened, so returning success while the chain has no
   * entry for it would leave durable state disagreeing with the world — the
   * condition the provenance chain exists to make impossible to reach quietly.
   * The record is written through the supervisor's own repository and CAS, so
   * a concurrent tick cannot be overwritten.
   */
  const recorded = await recordPublication(args, outcome, options);
  if (!recorded.ok) {
    log(`RECORD_FAILED: ${safe(recorded.reason)}`);
    return 1;
  }
  return 0;
}

/**
 * Appends the publication to the supervisor's provenance chain.
 *
 * Opens the supervisor database only for this write, and only after a
 * publication actually happened — a read-only command should never create the
 * file, which is the `openForReading` discipline `supervise.ts` established.
 */
async function recordPublication(
  args: GithubPublishArgs,
  outcome: Extract<PublishOutcome, { kind: "PUBLISHED" }>,
  options: GithubCliOptions,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const { createSqliteSupervisorRepository } = await import(
    "../adapters/supervision/sqliteSupervisorRepository.js"
  );
  const path = process.env["FACTORY_SUPERVISOR_DB_PATH"] ?? DEFAULT_SUPERVISOR_DB_PATH;
  const repository = createSqliteSupervisorRepository(path);
  try {
    const state = await repository.load();
    if (state === undefined) {
      return { ok: false, reason: `no supervisor state exists at ${path}; run 'sf supervise tick' first` };
    }
    const next = withPublicationRecorded(state, {
      roadmapKey: args.roadmapKey,
      pullRequest: outcome.pullRequest,
      checks: outcome.checks,
      recordedAt: options.now?.() ?? Date.now(),
    });
    if (!next.ok) {
      return { ok: false, reason: next.reason };
    }
    await repository.compareAndSave(
      { ...next.state, version: state.version + 1, updatedAt: options.now?.() ?? Date.now() },
      state.version,
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    repository.close();
  }
}

/**
 * Reports whether a candidate is READY TO INTEGRATE, and integrates nothing.
 *
 * `--reviewed` is the operator's assertion that an independent review accepted
 * this exact commit. It is an input rather than something this command decides,
 * because whether a reviewer accepted the work is not a fact about GitHub —
 * C4/C5. Without it the verdict refuses, so the flag cannot manufacture an
 * acceptance, only decline to withhold one.
 */
export async function runGithubReadiness(
  args: GithubPublishArgs & { readonly reviewAccepted: boolean },
  options: GithubCliOptions = {},
): Promise<number> {
  const log = options.log ?? ((line: string): void => console.log(line));
  const deps = build(args, options);
  const candidate = candidateFrom(args);

  const local = await readLocalState(deps.git, args.baseRef);
  if (local === undefined) {
    log(`NOT_READY: HEAD or origin/${safe(args.baseRef)} could not be resolved to a commit`);
    return 1;
  }
  const repository = await deps.github.repository();
  const pullRequest = await deps.github.findPullRequest(args.headRef);
  const checks = await deps.github.checkStatus(args.headSha);

  const verdict = checkIntegrationReadiness({
    candidate,
    repository,
    expectedRepository: args.repository,
    pullRequest,
    checks,
    local,
    expectedRemoteUrl: args.remoteUrl,
    reviewAccepted: args.reviewAccepted,
  });

  if (!verdict.ok) {
    log(`NOT_READY: ${safe(verdict.reason)}`);
    // The check evidence is reported separately so an operator can tell
    // "no CI exists yet" from "the remote moved" without re-running anything.
    const evidence = checkCheckEvidence({ candidate, checks });
    if (!evidence.ok) {
      log(`  checks: ${safe(evidence.reason)}`);
    }
    return 1;
  }
  log(`READY: ${candidate.headSha} is bound to pull request #${pullRequest?.number ?? 0} with accepted evidence`);
  return 0;
}
