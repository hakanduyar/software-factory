/**
 * TASK-018 PART A — VERSIONED CATALOG UPGRADE.
 *
 * ================================================================
 * WHY THIS EXISTS
 * ================================================================
 * `reconcileRoadmapWithCatalog` refuses any persisted row whose DEFINITION
 * disagrees with the catalog, and TASK-012 pins that deliberately: it is the
 * guard that stopped a rewritten `workClass` from skipping independent review.
 * Appending a brand-new key is already safe. CHANGING an existing row's
 * definition is not — an installation seeded from the older catalog would
 * refuse its own roadmap at startup, and the only ways out would be to weaken
 * that guard or to hand-edit the database.
 *
 * So a definition change needs a declared, versioned path. This is it, and it is
 * the first migration mechanism in this codebase. It inherits the posture the
 * two existing version markers already take rather than replacing it:
 * `schema.ts` "intentionally ships no migration runner — only detection, so a
 * future migration mechanism has a safe, loud failure mode to build on rather
 * than silently misreading rows", and the supervisor store refuses a mismatched
 * version rather than "silently migrated: guessing at another version's
 * semantics is how state gets quietly corrupted".
 *
 * ================================================================
 * WHAT IT MAY AND MAY NOT DO
 * ================================================================
 * It may change DEFINITION fields, and only between two versions that are both
 * written down here. It may not invent a step, bridge a gap, downgrade, adopt
 * whatever the rows happen to say, or touch PROGRESS. Every unknown REFUSES.
 *
 * An upgrade restores knowledge, never authority: no step changes `status`,
 * satisfies a protected gate, or alters what `unprovenCompletion` refuses. The
 * only thing a step can make newly eligible is what a new dependency EDGE
 * makes eligible, and edges only ever add work to wait for.
 *
 * This module is PURE. It reads no database and writes nothing, so the refusal
 * decision can be tested without a filesystem, and so the caller — which owns
 * the transaction — is the only thing that can make a partial write.
 */

import { DEFINITION_FIELDS } from "./roadmapCatalog.js";
import { DEFAULT_ROADMAP, type RoadmapItem } from "./supervisorTypes.js";

/**
 * The catalog version THIS BUILD declares.
 *
 * Bumped by the same commit that changes `DEFAULT_ROADMAP`'s definitions, and
 * never on its own: a version that moved without the rows moving would describe
 * a state no database is ever in.
 */
export const ROADMAP_CATALOG_VERSION = 2;

/**
 * What an ABSENT version record means.
 *
 * Every database written before TASK-018 carries no `roadmap_catalog_version`,
 * and absence therefore means exactly one thing: the catalog that shipped
 * before this task. It does NOT mean "whatever the rows happen to be" — that
 * reading would let anyone who can delete one row in `supervisor_meta` choose
 * which catalog their database is measured against, and AC-4 then has nothing
 * to compare with. The rows still have to match v1 exactly, or the upgrade
 * refuses.
 */
export const PRE_UPGRADE_CATALOG_VERSION = 1;

/**
 * THE CATALOG AS IT SHIPPED AT VERSION 1 — a historical record, not
 * documentation, and not to be "tidied" to match a later `DEFAULT_ROADMAP`.
 *
 * It is a mechanical copy of `DEFAULT_ROADMAP` taken at commit `e633179`,
 * generated rather than transcribed. `tests/catalogUpgrade.test.ts` pins its
 * digest, so an accidental edit is a failing test rather than a migration that
 * quietly compares against the wrong past.
 */
export const CATALOG_V1: readonly RoadmapItem[] = [
  { key: "LOCAL_24_7_RUNTIME", title: "Reliable restartable WSL2 runtime on the existing PC", dependsOn: [], status: "PENDING", workClass: "ARCHITECTURE_SECURITY", order: 1 },
  { key: "SUPERVISOR_SERVICE", title: "Supervisor startup, scheduling and restart recovery", dependsOn: ["LOCAL_24_7_RUNTIME"], status: "PENDING", workClass: "HIGH_RISK_IMPLEMENTATION", order: 2 },
  { key: "EXECUTOR_ISOLATION", title: "Run executors in a restricted process with no ambient billing capability (network egress is NOT blocked)", dependsOn: ["SUPERVISOR_SERVICE"], status: "PENDING", workClass: "ARCHITECTURE_SECURITY", order: 3 },
  { key: "STATE_INTEGRITY", title: "Protect supervisor state and provenance against tampering (permissions, append-only audit)", dependsOn: ["SUPERVISOR_SERVICE"], status: "PENDING", workClass: "ARCHITECTURE_SECURITY", order: 4 },
  { key: "EXECUTOR_WIRING", title: "Wire the roadmap queue to TASK-005 planning and the TASK-004 loop", dependsOn: ["EXECUTOR_ISOLATION", "STATE_INTEGRITY"], status: "PENDING", workClass: "HIGH_RISK_IMPLEMENTATION", order: 5 },
  { key: "GITHUB_ORCHESTRATION", title: "GitHub Issues/Projects/PR orchestration (zero-cost tier only)", dependsOn: ["EXECUTOR_WIRING"], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 6 },
  { key: "CLEAN_ROOM_CI", title: "Strategic clean-environment CI within the included allowance", dependsOn: ["GITHUB_ORCHESTRATION"], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 7 },
  { key: "TELEGRAM_CONTROL_PLANE", title: "Telegram control plane", dependsOn: ["SUPERVISOR_SERVICE"], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 8 },
  { key: "N8N_INTEGRATION_BUS", title: "n8n integration bus", dependsOn: ["SUPERVISOR_SERVICE"], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 9 },
  { key: "CONTROL_ROOM", title: "Control Room operational visibility", dependsOn: ["GITHUB_ORCHESTRATION"], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 10 },
  { key: "MEASURED_MODEL_ROUTER", title: "Benchmark-driven model router", dependsOn: ["EXECUTOR_WIRING"], status: "PENDING", workClass: "HIGH_RISK_IMPLEMENTATION", order: 11 },
  { key: "BACKUP_RECOVERY", title: "Backup and disaster recovery on existing storage", dependsOn: ["LOCAL_24_7_RUNTIME"], status: "PENDING", workClass: "HIGH_RISK_IMPLEMENTATION", order: 12 },
  { key: "RELEASE_HARDENING", title: "Public-release separation and hardening", dependsOn: ["CONTROL_ROOM", "BACKUP_RECOVERY"], status: "PENDING", workClass: "ARCHITECTURE_SECURITY", order: 13 },
  { key: "END_TO_END_ACCEPTANCE", title: "Final end-to-end autonomous acceptance", dependsOn: ["RELEASE_HARDENING", "MEASURED_MODEL_ROUTER", "TELEGRAM_CONTROL_PLANE", "N8N_INTEGRATION_BUS", "CLEAN_ROOM_CI"], status: "PENDING", workClass: "ARCHITECTURE_SECURITY", order: 14 },
];

/**
 * One declared move between two adjacent versions.
 *
 * Both catalogs are carried in full rather than as a delta. A delta says what
 * the author MEANT to change; a full FROM catalog says what the database must
 * look like for that meaning to hold, which is the question AC-4 asks.
 */
export interface CatalogUpgradeStep {
  readonly from: number;
  readonly to: number;
  readonly fromCatalog: readonly RoadmapItem[];
  readonly toCatalog: readonly RoadmapItem[];
}

/**
 * Every upgrade this build knows how to perform.
 *
 * A version with no step leading forward from it is refused by name. Nothing is
 * inferred by diffing two catalogs: a diff would happily "upgrade" a database
 * this build has never seen, which is the silent-misreading failure the
 * existing version markers were written to avoid.
 */
export const CATALOG_UPGRADE_STEPS: readonly CatalogUpgradeStep[] = [
  { from: PRE_UPGRADE_CATALOG_VERSION, to: ROADMAP_CATALOG_VERSION, fromCatalog: CATALOG_V1, toCatalog: DEFAULT_ROADMAP },
];

export type CatalogUpgradeVerdict =
  | { readonly kind: "ALREADY_CURRENT"; readonly version: number }
  | {
      readonly kind: "UPGRADE";
      readonly from: number;
      readonly to: number;
      readonly roadmap: readonly RoadmapItem[];
      /** Bounded, for the audit record the caller appends. */
      readonly detail: string;
      /**
       * The roadmap item the audit record is filed under.
       *
       * DERIVED, and it has to be a REAL key: `parseSupervisorState` refuses a
       * provenance entry naming a roadmap item that does not exist, which is
       * how the chain stays tied to the thing it is about. A reserved name like
       * `(roadmap-catalog)` was the first attempt and was refused on the write
       * round-trip — correctly, and before anything reached the file.
       *
       * Derived rather than declared on the step, because a declared key can
       * name an item the step does not touch, and then the record points at
       * work the upgrade had nothing to do with. It is the item the upgrade
       * INTRODUCED where there is one, and otherwise the first item whose
       * definition it changes; a step that does neither changes nothing and
       * cannot arise.
       *
       * Keys never disappear — AC-7 refuses a step that would drop an item — so
       * a key valid when the record was written stays valid afterwards.
       */
      readonly auditKey: string;
    }
  | { readonly kind: "REFUSE"; readonly problem: string };

function indexByKey(
  entries: readonly RoadmapItem[],
  what: string,
): { readonly ok: true; readonly byKey: ReadonlyMap<string, RoadmapItem> } | { readonly ok: false; readonly problem: string } {
  const byKey = new Map<string, RoadmapItem>();
  for (const entry of entries) {
    if (byKey.has(entry.key)) {
      return { ok: false, problem: `${what} declares ${JSON.stringify(entry.key)} twice` };
    }
    byKey.set(entry.key, entry);
  }
  return { ok: true, byKey };
}

function sameDefinition(field: (typeof DEFINITION_FIELDS)[number], a: RoadmapItem, b: RoadmapItem): boolean {
  if (field === "dependsOn") {
    return a.dependsOn.length === b.dependsOn.length && a.dependsOn.every((key, index) => key === b.dependsOn[index]);
  }
  return a[field] === b[field];
}

/**
 * Applies ONE step, or explains why it will not.
 *
 * PROGRESS is carried by spreading the persisted row and overwriting only the
 * five DEFINITION fields from the target catalog. That single expression is
 * what AC-7 and AC-8 rest on, and it is deliberately the only place the output
 * row is built: a second "preserve the progress" safety net would be a sibling
 * guard able to mask this one, which is the defect this repository has now
 * found eighteen times.
 */
function applyStep(
  step: CatalogUpgradeStep,
  persisted: readonly RoadmapItem[],
): { readonly ok: true; readonly roadmap: readonly RoadmapItem[] } | { readonly ok: false; readonly problem: string } {
  const from = indexByKey(step.fromCatalog, `catalog version ${step.from}`);
  if (!from.ok) return from;
  const to = indexByKey(step.toCatalog, `catalog version ${step.to}`);
  if (!to.ok) return to;
  const rows = indexByKey(persisted, "the persisted roadmap");
  if (!rows.ok) return rows;

  const upgraded: RoadmapItem[] = [];
  for (const row of persisted) {
    const declared = from.byKey.get(row.key);
    if (declared === undefined) {
      /**
       * A key version `from` never declared. The database did not come from
       * the version it claims to, so nothing here knows what its rows mean.
       */
      return {
        ok: false,
        problem:
          `persisted roadmap item ${JSON.stringify(row.key)} is not declared by catalog version ${step.from}; ` +
          `declared keys: ${[...from.byKey.keys()].join(", ")}`,
      };
    }
    const disagreement = DEFINITION_FIELDS.find((field) => !sameDefinition(field, row, declared));
    if (disagreement !== undefined) {
      /**
       * AC-4. The row does not match the version it claims to be at, so this
       * step's meaning does not apply to it: it may be a hand edit, or the
       * residue of an attempt that was interrupted before its version record
       * moved. Either way the safe answer is the same one reconciliation gives.
       */
      return {
        ok: false,
        problem:
          `persisted roadmap item ${JSON.stringify(row.key)} disagrees with catalog version ${step.from} on ` +
          `${JSON.stringify(disagreement)}: persisted ${JSON.stringify(row[disagreement])}, ` +
          `version ${step.from} declares ${JSON.stringify(declared[disagreement])}`,
      };
    }

    const target = to.byKey.get(row.key);
    if (target === undefined) {
      /**
       * Removal is refused rather than performed. A dropped row takes its
       * PROGRESS with it — status, attempts, lineage — and AC-7 says completed
       * work survives an upgrade. No declared step removes anything; if one
       * ever needs to, that is a separate decision with its own criteria.
       */
      return {
        ok: false,
        problem:
          `catalog version ${step.to} would drop persisted roadmap item ${JSON.stringify(row.key)}, ` +
          "which would discard its recorded progress",
      };
    }

    upgraded.push({
      ...row,
      key: target.key,
      title: target.title,
      workClass: target.workClass,
      dependsOn: [...target.dependsOn],
      order: target.order,
    });
  }

  // A key the target declares and this database has never seen is an ordinary
  // addition, exactly as it is for `reconcileRoadmapWithCatalog`. It arrives
  // with the catalog's own status, which for everything this build ships is
  // PENDING — an upgrade cannot introduce work that is already DONE.
  for (const entry of step.toCatalog) {
    if (!rows.byKey.has(entry.key)) {
      upgraded.push({ ...entry, dependsOn: [...entry.dependsOn] });
    }
  }
  return { ok: true, roadmap: upgraded };
}

/**
 * Decides what, if anything, should happen to this database's roadmap.
 *
 * Returns a PLAN. It does not write, because the caller owns the transaction
 * that must move the rows and the version record together (AC-5) — and a
 * function that both decided and wrote could leave one without the other.
 */
export function planCatalogUpgrade(input: {
  /** Absent means "no record", which is v1 and nothing else. */
  readonly recordedVersion?: number;
  readonly persisted: readonly RoadmapItem[];
  readonly buildVersion?: number;
  readonly steps?: readonly CatalogUpgradeStep[];
}): CatalogUpgradeVerdict {
  const buildVersion = input.buildVersion ?? ROADMAP_CATALOG_VERSION;
  const steps = input.steps ?? CATALOG_UPGRADE_STEPS;
  const recorded = input.recordedVersion ?? PRE_UPGRADE_CATALOG_VERSION;

  if (!Number.isSafeInteger(recorded) || recorded < 1) {
    return {
      kind: "REFUSE",
      problem: `recorded roadmap catalog version ${JSON.stringify(input.recordedVersion)} is not a positive integer`,
    };
  }
  if (!Number.isSafeInteger(buildVersion) || buildVersion < 1) {
    return { kind: "REFUSE", problem: `this build declares an invalid roadmap catalog version ${JSON.stringify(buildVersion)}` };
  }

  if (recorded > buildVersion) {
    /**
     * A database from a NEWER build. Downgrading would mean deciding what a
     * future version's rows mean, which is precisely the guess this mechanism
     * exists to refuse.
     */
    return {
      kind: "REFUSE",
      problem:
        `the database records roadmap catalog version ${recorded}, which is newer than this build's ${buildVersion}; ` +
        "a catalog is never downgraded — run a build that declares that version",
    };
  }
  if (recorded === buildVersion) {
    return { kind: "ALREADY_CURRENT", version: recorded };
  }

  /**
   * THE CHAIN OF STEPS IS RESOLVED FIRST, from versions alone.
   *
   * Separating it from application is not tidiness. It means the walk cannot
   * half-apply and then discover there is no way forward, and it means the
   * chain is non-empty by construction when application begins — so the audit
   * key below needs no "this cannot happen" branch to fall back on, and AC-21's
   * rule against clauses that can never fire is satisfied structurally rather
   * than by anyone remembering it.
   */
  const chain: CatalogUpgradeStep[] = [];
  let current = recorded;
  while (current !== buildVersion) {
    const step = steps.find((candidate) => candidate.from === current);
    if (step === undefined) {
      /**
       * AC-3. Either a version this build has never heard of, or a gap in the
       * declared chain. Both are the same fact — there is no written-down way
       * forward from here — and bridging it would be inventing a step.
       */
      return {
        kind: "REFUSE",
        problem:
          `no declared roadmap catalog upgrade step leads forward from version ${current}` +
          (current === recorded ? "" : ` (reached from ${recorded})`) +
          `; this build declares version ${buildVersion} and steps: ` +
          (steps.length === 0 ? "(none)" : steps.map((entry) => `${entry.from}->${entry.to}`).join(", ")),
      };
    }
    if (step.to <= step.from) {
      // Without this the loop would never terminate, and a hang is a worse
      // failure than a refusal because nothing reports it.
      return {
        kind: "REFUSE",
        problem: `declared roadmap catalog upgrade step ${step.from}->${step.to} does not advance the version`,
      };
    }
    if (step.to > buildVersion) {
      return {
        kind: "REFUSE",
        problem: `declared roadmap catalog upgrade step ${step.from}->${step.to} overshoots this build's version ${buildVersion}`,
      };
    }
    chain.push(step);
    current = step.to;
  }

  // `recorded < buildVersion` was established above, so the chain has at least
  // one step and `chain[0]` is a step rather than a maybe.
  const first = chain[0]!;
  let roadmap = input.persisted;
  for (const step of chain) {
    const outcome = applyStep(step, roadmap);
    if (!outcome.ok) {
      return { kind: "REFUSE", problem: outcome.problem };
    }
    roadmap = outcome.roadmap;
  }

  return {
    kind: "UPGRADE",
    from: recorded,
    to: buildVersion,
    roadmap,
    detail: `roadmap catalog upgraded ${recorded} -> ${buildVersion} (steps: ${chain.map((step) => `${step.from}->${step.to}`).join(", ")})`,
    auditKey: stepAuditKey(first),
  };
}

/**
 * The item a step's audit record is filed under: what it INTRODUCED, or failing
 * that the first item whose definition it changes.
 *
 * Always a key the step's target catalog declares, which is what
 * `parseSupervisorState` requires of a provenance entry. The final fallback is
 * the target's first key: a step that neither introduces nor changes anything
 * is a step that does nothing, and filing its record against the catalog's
 * first item is more honest than inventing a name no catalog declares.
 */
function stepAuditKey(step: CatalogUpgradeStep): string {
  const known = new Set(step.fromCatalog.map((entry) => entry.key));
  const introduced = step.toCatalog.find((entry) => !known.has(entry.key));
  if (introduced !== undefined) {
    return introduced.key;
  }
  const fromByKey = new Map(step.fromCatalog.map((entry) => [entry.key, entry]));
  const changed = step.toCatalog.find((entry) => {
    const before = fromByKey.get(entry.key);
    return before !== undefined && DEFINITION_FIELDS.some((field) => !sameDefinition(field, before, entry));
  });
  return changed?.key ?? step.toCatalog[0]?.key ?? "";
}
