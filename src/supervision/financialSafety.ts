/**
 * THE FINANCIAL SAFETY GATE (TASK-006 §3).
 *
 * The Software Factory has exactly zero autonomous financial authority. This is
 * a hard security boundary, not a configuration preference, and this module is
 * where it lives.
 *
 * THE LOAD-BEARING DESIGN DECISION: this gate takes no `Actor`, no
 * `TrustedHumanToken`, no `Approval`, no plan and no model output. There is no
 * parameter through which authorization could be passed, so no caller — however
 * genuinely authorized for something else — can pass one. A PLAN_APPROVAL, a
 * RELEASE_APPROVAL, task acceptance, the autonomous completion mandate itself,
 * and a model announcing "purchase approved" therefore have exactly zero effect
 * on the verdict, because none of them can reach this function.
 *
 * That is the same discipline `Worker` follows in TASK-001 (a worker never
 * receives the identity credential, so it cannot mint a token): the safest
 * boundary is one that is structurally unable to be crossed, not one that is
 * merely policed.
 *
 * THE SECOND DECISION: classification is DERIVED, never declared. A caller may
 * state what it believes an action is, but the gate independently derives a
 * class from a registry of known action kinds and takes the MOST RESTRICTIVE of
 * the two. This is TASK-005 remediation round 1's lesson — "a caller that
 * describes its own target favourably can widen its own authority" — applied to
 * money.
 *
 * THE THIRD DECISION: uncertainty is financial. An unrecognised action kind is
 * `FINANCIAL_ACTION`. The supervisor only ever executes actions from a closed,
 * known set, so an unrecognised kind is genuinely suspicious rather than merely
 * unlisted.
 */

/**
 * Ordered least → most restrictive. Every class above `FREE_REMOTE_ACTION`
 * denies autonomous execution; the ordering decides which reason is reported
 * when a declared and a derived class disagree.
 *
 * FROZEN — review finding F4-1 (CRITICAL). `as const` gives a readonly TYPE and
 * a fully mutable ARRAY, and `mostRestrictive` ranked classes by their index in
 * it. Reordering the exported array therefore inverted the meaning of "most
 * restrictive", and `PROVISION_VPS` with a benign `declaredClass` came back
 * allowed. Compile-time readonly is not a runtime control.
 */
export const ACTION_CLASSES = Object.freeze([
  "FREE_LOCAL_ACTION",
  "FREE_REMOTE_ACTION",
  "PUBLICATION_ACTION",
  "DESTRUCTIVE_ACTION",
  "HUMAN_CREDENTIAL_ACTION",
  "FINANCIAL_ACTION",
] as const);

export type ActionClass = (typeof ACTION_CLASSES)[number];

/** The two classes the supervisor may execute without a human. */
const AUTONOMOUSLY_EXECUTABLE: readonly ActionClass[] = Object.freeze([
  "FREE_LOCAL_ACTION",
  "FREE_REMOTE_ACTION",
]);

/**
 * The ranking, stated explicitly rather than read from an array's index (F4-1).
 *
 * Even frozen, deriving a security decision from the ORDER of an exported list
 * makes the decision depend on a data structure other code can see and future
 * code might reorder for cosmetic reasons. An explicit map states the intent, and
 * a reordering of `ACTION_CLASSES` can no longer change any verdict.
 */
const RESTRICTION_RANK: Readonly<Record<ActionClass, number>> = Object.freeze({
  FREE_LOCAL_ACTION: 0,
  FREE_REMOTE_ACTION: 1,
  PUBLICATION_ACTION: 2,
  DESTRUCTIVE_ACTION: 3,
  HUMAN_CREDENTIAL_ACTION: 4,
  FINANCIAL_ACTION: 5,
});

function restrictionRank(actionClass: ActionClass): number {
  // An unrecognised class ranks maximally: uncertainty is financial, and that
  // rule applies to the ranking function too.
  return RESTRICTION_RANK[actionClass] ?? RESTRICTION_RANK.FINANCIAL_ACTION;
}

export function mostRestrictive(a: ActionClass, b: ActionClass): ActionClass {
  return restrictionRank(a) >= restrictionRank(b) ? a : b;
}

/**
 * What an action can actually DO, stated as deterministic facts rather than as
 * a conclusion. The class is computed from these; nobody hand-assigns a class
 * to a known action kind.
 */
export interface ActionEffects {
  /**
   * True only when the cost is deterministically zero: no charge now, no
   * metered usage later, no automatic conversion to a paid plan. "Free tier"
   * is NOT sufficient — see `deriveActionClass`.
   */
  readonly costKnownZero: boolean;
  readonly requiresPaymentMethod: boolean;
  readonly canIncurUsageCharges: boolean;
  readonly changesBillingConfiguration: boolean;
  readonly requiresHumanCredential: boolean;
  readonly makesPublic: boolean;
  readonly irreversibleDataLoss: boolean;
  readonly remote: boolean;
}

const LOCAL_FREE: ActionEffects = {
  costKnownZero: true,
  requiresPaymentMethod: false,
  canIncurUsageCharges: false,
  changesBillingConfiguration: false,
  requiresHumanCredential: false,
  makesPublic: false,
  irreversibleDataLoss: false,
  remote: false,
};

function effects(overrides: Partial<ActionEffects>): ActionEffects {
  return { ...LOCAL_FREE, ...overrides };
}

/**
 * Any of these makes an action financial, regardless of how small the amount
 * is. There is no de minimis exception: one cent is still unauthorized.
 */
function isFinancial(e: ActionEffects): boolean {
  return (
    !e.costKnownZero ||
    e.requiresPaymentMethod ||
    e.canIncurUsageCharges ||
    e.changesBillingConfiguration
  );
}

export function deriveActionClass(e: ActionEffects): ActionClass {
  // Financial is checked first and dominates: an action that is also
  // destructive or public is still, first and foremost, one that can charge.
  if (isFinancial(e)) {
    return "FINANCIAL_ACTION";
  }
  if (e.requiresHumanCredential) {
    return "HUMAN_CREDENTIAL_ACTION";
  }
  if (e.makesPublic) {
    return "PUBLICATION_ACTION";
  }
  if (e.irreversibleDataLoss) {
    return "DESTRUCTIVE_ACTION";
  }
  return e.remote ? "FREE_REMOTE_ACTION" : "FREE_LOCAL_ACTION";
}

/**
 * The closed set of actions the supervisor knows how to perform, with their
 * real effects. Anything absent from this table is treated as financial.
 *
 * ON USING AN ALREADY-AUTHORIZED AI SUBSCRIPTION: invoking Claude or Codex
 * inside the quota a human already pays for creates no new financial
 * commitment, so it is `FREE_REMOTE_ACTION`. The mandate says so directly —
 * exhausted limits must produce WAITING_FOR_RESOURCE, and an eligible fallback
 * "that does not create additional cost" is permitted. Every action that would
 * ENLARGE that spend — overage, top-up, credits, plan upgrade — is listed
 * separately and is financial.
 */
const KNOWN_ACTION_EFFECTS_TABLE: Record<string, ActionEffects> = {
  // ---- local, deterministic, free ----
  RUN_TESTS: LOCAL_FREE,
  RUN_BUILD: LOCAL_FREE,
  RUN_TYPECHECK: LOCAL_FREE,
  /**
   * Invoking the trusted local executor for a DETERMINISTIC roadmap item.
   *
   * NOTE what this authorises and what it does not (F4-4). It authorises running
   * in-repository code that the WIRING chose — the same trust boundary
   * TASK-003's `Worker` has. It does NOT authorise an arbitrary command line:
   * `RUN_VERIFICATION_COMMAND` used to be listed here as unconditionally free
   * while naming no command, which made `gcloud compute instances create` a
   * "free verification". That kind is now resource-parameterised and must be
   * minted by `verificationCommandAction` against an executable allowlist.
   */
  RUN_DETERMINISTIC_WORK: LOCAL_FREE,
  GIT_COMMIT: LOCAL_FREE,
  GIT_BRANCH: LOCAL_FREE,
  GIT_MERGE_SQUASH: LOCAL_FREE,
  READ_REPOSITORY: LOCAL_FREE,
  WRITE_CHECKPOINT: LOCAL_FREE,
  PROBE_RESOURCE_LOCAL: LOCAL_FREE,
  /**
   * Authoring a plan for a roadmap item. Free and local — the human judgement
   * it needs is a DECISION, not a payment, and conflating the two produces the
   * nonsense of telling an operator to make a transaction in order to write a
   * document.
   */
  AUTHOR_PLAN: LOCAL_FREE,

  // ---- remote, but creating no financial commitment ----
  /**
   * Read-only and triggers nothing on the far side.
   */
  GIT_FETCH: effects({ remote: true }),

  /**
   * REVIEW FINDING F5-FIN-4 (HIGH). `GIT_PUSH` and `PROBE_RESOURCE_REMOTE` were
   * registered here as free-but-remote on no evidence at all. A push can start
   * paid CI, fire paid webhooks, or consume the GitHub Actions allowance the
   * runtime amendment says must never be automatically exceeded; a remote probe
   * can hit a metered endpoint. Neither is performed by TASK-006, so making them
   * human-gated costs nothing today and removes a claim that was never proven.
   *
   * A push to a target with demonstrated zero liability could earn a minted
   * action later, the way verification commands did. It has not, so it does not
   * get the verdict.
   */
  GIT_PUSH: effects({ remote: true, costKnownZero: false, canIncurUsageCharges: true }),
  PROBE_RESOURCE_REMOTE: effects({ remote: true, costKnownZero: false, canIncurUsageCharges: true }),
  /**
   * NOTE: `LAUNCH_AI_WORKER`/`LAUNCH_AI_REVIEWER` are deliberately ABSENT.
   *
   * Review finding F-2 (CRITICAL): they were listed here as unconditionally
   * free, which asserted a fact about billing that the action itself does not
   * carry — a usage-billed provider would have classified as free. Whether
   * running a model costs money is a property of the RESOURCE, not of the verb,
   * so it is resolved by `billingMode` in `launchAiWorkerAction` below. With no
   * entry here, the uncertainty rule makes a bare launch financial by default.
   */

  // ---- human-credential-only ----
  SUDO_COMMAND: effects({ requiresHumanCredential: true }),
  OAUTH_CONSENT: effects({ remote: true, requiresHumanCredential: true }),
  MFA_CHALLENGE: effects({ remote: true, requiresHumanCredential: true }),
  PROVIDER_LOGIN: effects({ remote: true, requiresHumanCredential: true }),

  // ---- publication ----
  MAKE_REPOSITORY_PUBLIC: effects({ remote: true, makesPublic: true }),
  PUBLISH_PACKAGE: effects({ remote: true, makesPublic: true }),

  // ---- destructive ----
  DELETE_REMOTE_BRANCH: effects({ remote: true, irreversibleDataLoss: true }),
  FORCE_PUSH: effects({ remote: true, irreversibleDataLoss: true }),
  DROP_DATABASE: effects({ irreversibleDataLoss: true }),

  // ---- financial: anything that can debit a card or create liability ----
  PROVISION_VPS: effects({ remote: true, costKnownZero: false, requiresPaymentMethod: true, canIncurUsageCharges: true }),
  PROVISION_CLOUD_VM: effects({ remote: true, costKnownZero: false, requiresPaymentMethod: true, canIncurUsageCharges: true }),
  PROVISION_MANAGED_DATABASE: effects({ remote: true, costKnownZero: false, canIncurUsageCharges: true }),
  PROVISION_OBJECT_STORAGE: effects({ remote: true, costKnownZero: false, canIncurUsageCharges: true }),
  PURCHASE_AI_CREDITS: effects({ remote: true, costKnownZero: false, requiresPaymentMethod: true }),
  UPGRADE_SUBSCRIPTION: effects({ remote: true, costKnownZero: false, changesBillingConfiguration: true }),
  ENABLE_PAY_AS_YOU_GO: effects({ remote: true, costKnownZero: false, changesBillingConfiguration: true, canIncurUsageCharges: true }),
  ENABLE_PAID_OVERAGE: effects({ remote: true, costKnownZero: false, changesBillingConfiguration: true, canIncurUsageCharges: true }),
  ENABLE_AUTO_TOPUP: effects({ remote: true, costKnownZero: false, changesBillingConfiguration: true }),
  ADD_PAYMENT_METHOD: effects({ remote: true, changesBillingConfiguration: true }),
  RAISE_SPENDING_LIMIT: effects({ remote: true, changesBillingConfiguration: true }),
  PURCHASE_DOMAIN: effects({ remote: true, costKnownZero: false, requiresPaymentMethod: true }),
  PURCHASE_MARKETPLACE_ADDON: effects({ remote: true, costKnownZero: false, requiresPaymentMethod: true }),
  ACCEPT_BILLING_TERMS: effects({ remote: true, changesBillingConfiguration: true }),
  /**
   * A "free tier" that requires a card on file, meters usage, or can convert
   * automatically is financial. Only a resource deterministically known to cost
   * zero with no liability qualifies as FREE_REMOTE_ACTION.
   */
  PROVISION_FREE_TIER_WITH_BILLING: effects({ remote: true, requiresPaymentMethod: true, canIncurUsageCharges: true }),
};

/**
 * The registry, deeply frozen (review finding NEW-FIN-2, CRITICAL).
 *
 * It was exported as a plain object, so an in-process caller could simply
 * assign benign effects to `KNOWN_ACTION_EFFECTS.PROVISION_VPS` and the gate
 * would then permit it. A security-critical lookup table that anything in the
 * process can rewrite is not a control; freezing costs nothing and makes the
 * table what it claims to be.
 */
export const KNOWN_ACTION_EFFECTS: Readonly<Record<string, Readonly<ActionEffects>>> = Object.freeze(
  Object.fromEntries(
    Object.entries(KNOWN_ACTION_EFFECTS_TABLE).map(([kind, value]) => [kind, Object.freeze({ ...value })]),
  ),
);

/** What the supervisor is being asked to do. Deliberately carries no authority. */
export interface SupervisedAction {
  readonly kind: string;
  readonly description: string;
  /** What the caller BELIEVES this is. Advisory only; never able to lower the verdict. */
  readonly declaredClass?: ActionClass;
  /** Free-text, bounded, for the human escalation record. Never a credential. */
  readonly detail?: string;
  /**
   * Supplied when the action's cost depends on a resource rather than on the
   * verb — see `effects` below and finding F-2.
   */
  readonly effects?: ActionEffects;
}

/**
 * How a provider resource is paid for. Only an INCLUDED_SUBSCRIPTION creates no
 * new financial commitment when used; everything else can bill, and anything
 * unknown is treated as though it can.
 */
export const BILLING_MODES = ["INCLUDED_SUBSCRIPTION", "USAGE_BILLED", "UNKNOWN"] as const;

export type BillingMode = (typeof BILLING_MODES)[number];

/**
 * The ONLY kinds whose cost is a property of WHAT they touch rather than of the
 * verb itself. For these, the registry cannot answer the question, so the facts
 * must come from somewhere — and review finding F4-2 (CRITICAL) is about where.
 *
 * Round 2 let `action.effects` answer it. Round 4 found the obvious consequence:
 * ANY caller could hand
 *
 *   { kind: "LAUNCH_AI_WORKER", effects: { costKnownZero: true, ... } }
 *
 * straight to the gate and be told `FREE_REMOTE_ACTION`. `launchAiWorkerAction`
 * was the intended door, but nothing made it the only one — and an intended door
 * beside an open wall is decoration. Same class of mistake as N-1, one level
 * further out: N-1 let effects override the REGISTRY, F4-2 let them BE the
 * registry.
 *
 * The fix is structural rather than procedural. Authoritative effects for these
 * kinds live in a module-private `WeakMap` keyed on the action object, written
 * only by the minters below. A caller cannot reach the map, cannot add to it,
 * and cannot copy an entry: `{ ...mintedAction, effects: benign }` is a
 * DIFFERENT object and is therefore unminted, hence financial. `action.effects`
 * remains readable and may still make a verdict stricter, but it can no longer
 * make one permissive.
 */
const RESOURCE_PARAMETERISED_KINDS: ReadonlySet<string> = Object.freeze(
  new Set(["LAUNCH_AI_WORKER", "LAUNCH_AI_REVIEWER", "RUN_VERIFICATION_COMMAND"]),
) as ReadonlySet<string>;

/**
 * The authoritative facts for one minted action. Module-private and unreachable
 * from outside this file — the whole point (F4-2).
 *
 * REVIEW FINDING F5-SEC-1 (CRITICAL), introduced by the F4-2 fix. Binding the
 * effects to the OBJECT was necessary and not sufficient: the map survived
 * mutation of the object, so
 *
 *   const a = launchAiWorkerAction({ billingMode: "INCLUDED_SUBSCRIPTION", ... });
 *   a.kind = "RUN_VERIFICATION_COMMAND";
 *
 * carried a legitimately-minted "this model is on a subscription" fact into a
 * verdict about a shell command. The mint proved the action came from a minter;
 * it did not prove it was still the action that had been minted.
 *
 * Two changes, either of which alone would close it, both kept because this
 * exact mistake has now been made twice in two rounds:
 *
 *   1. the minted action and its effects are FROZEN, so the mutation throws;
 *   2. the mint records the KIND it was minted for, and a mismatch at
 *      evaluation time is financial — so even a future non-frozen path cannot
 *      launder facts from one kind into another.
 */
interface MintRecord {
  readonly kind: string;
  readonly effects: ActionEffects;
  /**
   * The canonical resource this verdict is ABOUT (F6-FIN-1).
   *
   * The mint recorded how the action is billed and not WHAT it is billed for,
   * so an "included subscription" verdict minted for one resource said nothing
   * about which resource actually got launched:
   *
   *   launchAiWorkerAction({ resourceKey: "metered:model",
   *                          billingMode: "INCLUDED_SUBSCRIPTION" })
   *
   * passed the gate, and the gate had no way to notice that the two halves
   * disagreed or that a different resource was used afterwards. The identity
   * now travels WITH the verdict, and `mintedResourceKey` lets the caller about
   * to launch assert that it is launching the thing that was cleared.
   */
  readonly resourceKey?: string;
}

const MINTED: WeakMap<SupervisedAction, MintRecord> = new WeakMap();

function mint(
  action: SupervisedAction,
  derivedEffects: ActionEffects,
  resourceKeyValue?: string,
): SupervisedAction {
  const effectsFrozen = Object.freeze({ ...derivedEffects });
  const frozen = Object.freeze({ ...action, effects: effectsFrozen });
  MINTED.set(frozen, {
    kind: frozen.kind,
    effects: effectsFrozen,
    ...(resourceKeyValue === undefined ? {} : { resourceKey: resourceKeyValue }),
  });
  return frozen;
}

/**
 * The resource a verdict was minted FOR, or `undefined` if the action was not
 * minted or names no resource (F6-FIN-1).
 *
 * Callers that launch something must compare this against what they are about
 * to launch. A verdict is about a specific resource; using it for a different
 * one is not "reusing an approval", it is using an approval for something that
 * was never approved.
 */
export function mintedResourceKey(action: SupervisedAction): string | undefined {
  return MINTED.get(action)?.resourceKey;
}

/**
 * Builds the action for running a model on a specific resource (F-2, F4-2).
 *
 * Using quota a human already pays for creates no NEW liability, which is why
 * an included subscription is free here — the mandate says so directly, in
 * requiring that exhausted limits produce WAITING_FOR_RESOURCE rather than a
 * purchase. A metered resource, or one whose billing is not known, is
 * financial: it could add to a bill, and uncertainty is financial.
 *
 * `billingMode` must come from a PROBE OBSERVATION, not from configuration and
 * not from a persisted row — see `SupervisorService.billingModeFor` and finding
 * F4-3. This function cannot verify that, which is precisely why the supervisor
 * re-confirms the resource in-process immediately before it calls this.
 */
/**
 * Evidence that a specific resource's billing mode was OBSERVED (R10-FIN-1).
 *
 * The tenth review's successful attack was the last one standing: the public
 * minter took `billingMode` as a plain string, so
 *
 *   launchAiWorkerAction({ resourceKey: "metered:model",
 *                          billingMode: "INCLUDED_SUBSCRIPTION" })
 *
 * returned `FREE_REMOTE_ACTION`. The supervisor's own path re-probes and could
 * not produce that, but a PUBLIC API that lets any caller assert a resource is
 * free is a defect regardless of who currently calls it — every previous finding
 * in this file is a variation on trusting a value someone else supplied.
 *
 * A billing mode can no longer be passed as a bare string. It must arrive inside
 * an observation, minted here, bound to the provider and model it describes.
 *
 * HONEST LIMIT: this makes asserting "that resource is free" a deliberate,
 * greppable act rather than an incidental argument. It does not make it
 * impossible — an in-process caller can still construct an observation, exactly
 * as it could construct anything else.
 *
 * NARROWED BY TASK-011 (EXECUTOR_ISOLATION), and stated precisely rather than
 * declared closed: the executor now runs in its own process with no credential
 * store, so EXECUTOR code is no longer an in-process caller and cannot mint an
 * observation at all. What remains is that anything running INSIDE the
 * supervisor process still can. That is a smaller surface — supervisor code
 * this repository owns and reviews — rather than the open-ended one it was when
 * executors ran here too.
 *
 * What would close the residue entirely is moving the probe out of this process
 * as well. Nothing does that today, and no comment here should imply otherwise.
 */
export interface BillingObservation {
  readonly provider: string;
  readonly model: string;
  readonly billingMode: BillingMode;
}

const OBSERVATIONS = new WeakSet<BillingObservation>();

/**
 * Records what a PROBE reported about a resource.
 *
 * Call this only with the result of an actual zero-token probe. The supervisor
 * does so immediately before every launch (F4-3); nothing else should call it.
 */
export function observeBilling(input: {
  readonly provider: string;
  readonly model: string;
  readonly billingMode: BillingMode | undefined;
}): BillingObservation {
  const observation = Object.freeze({
    provider: input.provider,
    model: input.model,
    // Absent observation is UNKNOWN, and unknown is financial.
    billingMode: input.billingMode ?? "UNKNOWN",
  });
  OBSERVATIONS.add(observation);
  return observation;
}

/**
 * Builds a launch action for a resource whose billing was observed.
 *
 * An observation that did not come from `observeBilling`, or that describes a
 * DIFFERENT resource than the one being launched, is treated as no observation
 * at all — which is UNKNOWN, which is financial.
 */
export function launchAiWorkerAction(input: {
  readonly resourceKey: string;
  readonly observation?: BillingObservation;
  readonly description: string;
  readonly reviewer?: boolean;
}): SupervisedAction {
  const observation = input.observation;
  const trusted =
    observation !== undefined &&
    OBSERVATIONS.has(observation) &&
    `${observation.provider}:${observation.model}` === input.resourceKey;
  const billingMode: BillingMode = trusted ? observation.billingMode : "UNKNOWN";
  const included = billingMode === "INCLUDED_SUBSCRIPTION";
  const derivedEffects = effects({
    remote: true,
    costKnownZero: included,
    canIncurUsageCharges: !included,
  });
  return mint(
    {
      kind: input.reviewer === true ? "LAUNCH_AI_REVIEWER" : "LAUNCH_AI_WORKER",
      description: input.description,
      // Human-readable only. The BINDING copy lives in the mint record, where a
      // caller cannot rewrite it (F6-FIN-1).
      detail: `resource ${input.resourceKey}, billing ${billingMode}`,
      effects: derivedEffects,
    },
    derivedEffects,
    input.resourceKey,
  );
}

/**
 * The closed set of verification commands this build accepts as zero-cost, as
 * WHOLE COMMANDS rather than as executables (F4-4, then F5-FIN-1).
 *
 * Round 4 allowlisted EXECUTABLES. The fifth review took that apart in one line:
 * an allowlist of executables cannot constrain what they do. Every one of these
 * passed:
 *
 *   npm run charge                 (package.json defines the script)
 *   npx some-chargeable-package    (fetches and runs remote code)
 *   node --import /tmp/paid.mjs    (runs arbitrary code)
 *   sh -c "curl https://billing.example/charge"
 *   git push origin main           (can trigger paid CI)
 *
 * `sh` and `bash` being on that list was simply wrong — a shell is not a
 * command, it is permission to run any command. So the unit of authorization is
 * now the entire argv, fixed here, selected by an IDENTIFIER. A caller names
 * `NPM_TEST`; it does not get to say what `NPM_TEST` runs.
 *
 * RESIDUAL, stated rather than glossed: `npm test` and `npm run build` execute
 * scripts defined in this repository's `package.json`. Whoever can rewrite those
 * scripts can make these commands do anything — but that is the pre-existing
 * trust level of the repository itself, not a new hole this gate opens. What
 * this table guarantees is narrower and true: no command reaches a
 * FREE_LOCAL_ACTION verdict without appearing here verbatim.
 */
const ZERO_COST_COMMANDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  NPM_TEST: Object.freeze(["npm", "test"]),
  NPM_RUN_BUILD: Object.freeze(["npm", "run", "build"]),
  NPM_RUN_TYPECHECK: Object.freeze(["npm", "run", "typecheck"]),
  NPM_RUN_VERIFY: Object.freeze(["npm", "run", "verify"]),
  GIT_STATUS: Object.freeze(["git", "status", "--porcelain"]),
  GIT_DIFF_CHECK: Object.freeze(["git", "diff", "--check"]),
  NODE_VERSION: Object.freeze(["node", "--version"]),
});

/** The identifiers a caller may name. Anything else is financial. */
export const ZERO_COST_COMMAND_IDS: readonly string[] = Object.freeze(Object.keys(ZERO_COST_COMMANDS));

/** The exact argv an identifier resolves to, for the executor that will run it. */
export function zeroCostCommandArgv(id: string): readonly string[] | undefined {
  return Object.prototype.hasOwnProperty.call(ZERO_COST_COMMANDS, id) ? ZERO_COST_COMMANDS[id] : undefined;
}

/**
 * Builds the action for running ONE verification command (F4-4, F5-FIN-1).
 *
 * This is the only way to obtain a non-financial verdict for
 * `RUN_VERIFICATION_COMMAND`, and the only thing a caller supplies is which
 * entry of the closed table to use. An unrecognised identifier is financial —
 * not because the command necessarily costs money, but because this gate cannot
 * know that it does not, and "do not guess that something is free" is the rule.
 *
 * HONEST BOUNDARY, and it MOVED — this note said "later task" until TASK-011
 * shipped, and a stale boundary note is a lie with a good excuse.
 *
 * What has not changed: the gate authorises a LAUNCH. It cannot police what
 * trusted IN-PROCESS executor code does afterwards, any more than TASK-003's
 * `Worker` boundary can — an executor that can call `fetch` is not stopped by a
 * function in the same process.
 *
 * What HAS changed: `createIsolatedExecutor` exists (TASK-011). It runs the
 * executor in a separate process with a filtered environment, a filesystem
 * permission model, no inherited credentials and a closed inspector, so for
 * work that goes through it the enforcement is no longer aspirational.
 *
 * What is STILL true, and is the reason this paragraph is not simply deleted:
 * the isolated executor is not yet WIRED. `EXECUTOR_WIRING` depends on both
 * `EXECUTOR_ISOLATION` and `STATE_INTEGRITY`, and until it lands the production
 * CLI still uses the explicitly named `createUnimplementedExecutor`. So the gate
 * is the only thing standing in front of the in-process path that exists today,
 * exactly as this note has always said — and it will stop being the only thing
 * when the wiring lands, not before.
 *
 * Network egress is NOT blocked even in the isolated child, and is recorded in
 * docs/KNOWN-LIMITATIONS.md rather than assumed away.
 */
export function verificationCommandAction(input: {
  readonly commandId: string;
  readonly description: string;
}): SupervisedAction {
  const argv = zeroCostCommandArgv(input.commandId);
  const derivedEffects =
    argv === undefined ? effects({ costKnownZero: false, canIncurUsageCharges: true, remote: true }) : LOCAL_FREE;
  return mint(
    {
      kind: "RUN_VERIFICATION_COMMAND",
      description: input.description,
      detail: argv === undefined ? `unrecognised command "${input.commandId}"` : `command ${input.commandId}`,
      effects: derivedEffects,
    },
    derivedEffects,
  );
}

export interface FinancialPolicy {
  readonly autonomousSpendAllowed: boolean;
  /** Currency-agnostic, and required to be exactly 0 — see `parseFinancialPolicy`. */
  readonly autonomousSpendLimit: number;
}

/** The secure default, and the value used whenever policy cannot be trusted. */
export const DENY_ALL_SPENDING: FinancialPolicy = { autonomousSpendAllowed: false, autonomousSpendLimit: 0 };

export type FinancialPolicyResult =
  | { readonly ok: true; readonly value: FinancialPolicy }
  | { readonly ok: false; readonly reason: string };

/**
 * Strict, fail-closed policy parsing. Missing, unreadable, malformed or
 * type-invalid policy is NOT "no restrictions" — it is a refusal to act.
 *
 * REVIEW FINDING F-1 (CRITICAL). This previously accepted a positive limit, and
 * the gate honoured it. That made SPENDING AUTHORITY A PROPERTY OF WRITABLE
 * DATA: anything able to write the supervisor row — a bug, a corrupted file, a
 * future code path, an attacker with filesystem access — could grant the
 * Factory a budget. "Authorization must never be inferred" has to include
 * "never inferred from a row the Factory itself writes".
 *
 * So a policy claiming permission to spend is now itself refused as untrusted,
 * and the gate has no branch that allows a financial action at all. Raising the
 * limit is deliberately a CODE change, which goes through review and an
 * independent acceptance gate — not a data edit that could happen silently.
 */
export function parseFinancialPolicy(raw: unknown): FinancialPolicyResult {
  if (raw === undefined || raw === null) {
    return { ok: false, reason: "no financial policy is recorded" };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: `financial policy must be an object, got ${JSON.stringify(raw)}` };
  }
  const row = raw as Record<string, unknown>;
  const allowed = row["autonomousSpendAllowed"];
  const limit = row["autonomousSpendLimit"];
  if (typeof allowed !== "boolean") {
    return { ok: false, reason: `autonomousSpendAllowed must be a boolean, got ${JSON.stringify(allowed)}` };
  }
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0) {
    return { ok: false, reason: `autonomousSpendLimit must be a finite non-negative number, got ${JSON.stringify(limit)}` };
  }
  // An internally contradictory policy is corruption, not a permission.
  if (!allowed && limit !== 0) {
    return { ok: false, reason: `policy denies autonomous spend but records a limit of ${limit}` };
  }
  // F-1: a stored policy may not grant spending authority. AUTONOMOUS_SPEND_LIMIT
  // is zero for this build, and a row claiming otherwise is untrusted data.
  if (allowed || limit !== 0) {
    return {
      ok: false,
      reason: `stored policy claims autonomous spending (allowed=${allowed}, limit=${limit}); spending authority cannot be granted by persisted data`,
    };
  }
  return { ok: true, value: { autonomousSpendAllowed: allowed, autonomousSpendLimit: limit } };
}

export type FinancialVerdict =
  | { readonly allowed: true; readonly actionClass: ActionClass }
  | {
      readonly allowed: false;
      readonly actionClass: ActionClass;
      readonly reason: string;
      /** Exactly what only a human can do. Recorded on the WAITING_FOR_HUMAN_REQUIRED state. */
      readonly humanActionRequired: string;
    };

function humanActionFor(actionClass: ActionClass, action: SupervisedAction): string {
  switch (actionClass) {
    case "FINANCIAL_ACTION":
      return `A human must personally perform this transaction: ${action.description}. The Factory has no autonomous financial authority, and a saved payment method is not authorization.`;
    case "HUMAN_CREDENTIAL_ACTION":
      return `A human must supply the credential/consent this requires: ${action.description}.`;
    case "PUBLICATION_ACTION":
      return `A human must authorize making this public: ${action.description} (C1).`;
    case "DESTRUCTIVE_ACTION":
      return `A human must authorize this irreversible operation: ${action.description} (C7).`;
    default:
      return `A human must review: ${action.description}.`;
  }
}

/**
 * THE GATE.
 *
 * Note the signature: `action` and `policy` only. No actor, no token, no
 * approval, no model output — see the module docs for why that is the point
 * rather than an oversight.
 */
export function evaluateFinancialSafety(action: SupervisedAction, policy: FinancialPolicyResult): FinancialVerdict {
  /**
   * REVIEW FINDING N-1 (CRITICAL), introduced by the F-2 fix and caught by the
   * re-review. Letting `action.effects` simply REPLACE the registry meant a
   * caller could hand benign effects to `PROVISION_VPS` and receive
   * FREE_REMOTE_ACTION. That is the exact "declared, not derived" hole this
   * module was written to close, reintroduced through the side door while
   * fixing something else.
   *
   * The rule now distinguishes two cases:
   *
   *   - For the handful of kinds whose cost genuinely depends on WHICH RESOURCE
   *     they touch, effects are the only way to know, and are REQUIRED. Absent
   *     effects mean absent knowledge, which is financial.
   *   - For every other kind, the registry is authoritative and caller effects
   *     may only make the verdict STRICTER. They can never talk it down.
   */
  const resourceParameterised = RESOURCE_PARAMETERISED_KINDS.has(action.kind);

  let derived: ActionClass;
  if (resourceParameterised) {
    /**
     * F4-2 (CRITICAL). The authoritative facts come from the module-private
     * mint, NEVER from `action.effects` — which is a field any caller can set
     * to whatever it likes. An action that did not come from a minter has no
     * entry, and no entry means no knowledge, which is financial.
     *
     * A caller's own `effects` may still make the answer stricter below; it can
     * no longer make it permissive.
     */
    const minted = MINTED.get(action);
    // F5-SEC-1: the mint must be for THIS kind. A record minted for
    // LAUNCH_AI_WORKER says nothing about a RUN_VERIFICATION_COMMAND, however
    // the object came to be carrying both.
    derived =
      minted === undefined || minted.kind !== action.kind
        ? "FINANCIAL_ACTION"
        : deriveActionClass(minted.effects);
  } else {
    // Uncertainty is financial. The supervisor executes a closed set of
    // actions, so an unrecognised kind is suspicious rather than merely
    // unlisted.
    const known = Object.prototype.hasOwnProperty.call(KNOWN_ACTION_EFFECTS, action.kind)
      ? KNOWN_ACTION_EFFECTS[action.kind]
      : undefined;
    const fromRegistry: ActionClass = known === undefined ? "FINANCIAL_ACTION" : deriveActionClass(known);
    derived =
      action.effects === undefined
        ? fromRegistry
        : mostRestrictive(fromRegistry, deriveActionClass(action.effects));
  }
  const effective = action.declaredClass === undefined ? derived : mostRestrictive(action.declaredClass, derived);

  /**
   * AN UNTRUSTED FINANCIAL POLICY DENIES EVERYTHING (F6-POL-1).
   *
   * Earlier rounds let purely LOCAL work continue under a malformed policy, on
   * the reasoning that refusing to run the test suite because a policy row is
   * corrupt is brittleness rather than safety, and that it blocks the very
   * diagnosis that would fix it. That reasoning is not worthless — but it is an
   * argument for a different rule than the one the mandate states, and the
   * mandate is explicit: *"Missing/corrupt/unreadable policy: DENY. Do not
   * default to allow."* Two consecutive independent reviews read the earlier
   * behaviour as not satisfying it, which is the answer to whether the exception
   * was as obvious as it felt.
   *
   * So: no supervised action executes autonomously while the policy is
   * unreadable. Diagnosis is unaffected in practice — a human at a terminal runs
   * `npm test` directly, and `sf supervise status`/`resources`/`roadmap` read
   * state without going through this gate. What stops is AUTONOMOUS execution,
   * which is exactly what the rule is about.
   */
  if (!policy.ok) {
    return {
      allowed: false,
      actionClass: effective,
      reason: `the financial policy could not be trusted, so nothing may run autonomously: ${policy.reason}`,
      humanActionRequired: `Repair the Factory's financial policy record, then retry: ${action.description}`,
    };
  }

  if (!AUTONOMOUSLY_EXECUTABLE.includes(effective)) {
    // The policy is consulted ONLY here, and only to confirm what it already
    // is: denial. There is deliberately no branch in which a policy value
    // turns a HUMAN_CREDENTIAL/PUBLICATION/DESTRUCTIVE action into an allowed
    // one — spending policy governs spending, not those boundaries.
    if (effective === "FINANCIAL_ACTION") {
      // F-1: there is deliberately NO branch here that allows a financial
      // action. The policy is consulted only to report WHY, never to permit —
      // so no value any row could hold produces `allowed: true`.
      // An untrusted policy no longer reaches this point at all: since F6-POL-1
      // it denies everything above, so by here the policy is known-good and the
      // refusal is about the ACTION.
      const unknownKind =
        !resourceParameterised && !Object.prototype.hasOwnProperty.call(KNOWN_ACTION_EFFECTS, action.kind);
      const detail = unknownKind
        ? `action kind "${action.kind}" is not a known non-financial action; uncertainty is treated as financial`
        : "the Factory has no autonomous financial authority";
      return {
        allowed: false,
        actionClass: effective,
        reason: `financial action refused: ${detail}`,
        humanActionRequired: humanActionFor(effective, action),
      };
    }
    return {
      allowed: false,
      actionClass: effective,
      reason: `${effective} may not be performed autonomously`,
      humanActionRequired: humanActionFor(effective, action),
    };
  }

  return { allowed: true, actionClass: effective };
}
