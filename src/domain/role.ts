/**
 * Factory roles (docs/MODEL_ROUTING.md).
 *
 * A role describes the job to be done, never the vendor that does it (C9).
 */

export const FACTORY_ROLES = [
  "ANALYST",
  "PLANNER",
  "IMPLEMENTER",
  "VERIFIER",
  "REVIEWER",
  "CONTENT",
] as const;

export type FactoryRole = (typeof FACTORY_ROLES)[number];
