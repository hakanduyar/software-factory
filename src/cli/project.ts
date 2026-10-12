/**
 * `sf project create <key> --name <name>` — the minimal bootstrap needed
 * before `sf plan request` can target a project.
 *
 * Validation of `key`/`name` happens BEFORE any filesystem/DB access so a
 * blank invocation never creates a `.factory-data` directory or an empty
 * database file.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { createSqliteStore } from "../adapters/sqlite/sqliteStore.js";
import { createLocalWorkerRegistry } from "../adapters/security/localWorkerRegistry.js";
import { FactoryService } from "../app/factoryService.js";
import { systemClock } from "../ports/clock.js";
import { createRandomIdGenerator } from "../domain/ids.js";
import type { Project } from "../domain/project.js";
import type { HumanIdentityGate } from "../ports/humanIdentityGate.js";

/**
 * `sf project create` never authorizes or verifies a human: nothing on this
 * path records an Approval, so there is no legitimate caller for either
 * method. Both fail closed instead of silently trusting anything.
 */
const NO_IDENTITY_GATE: HumanIdentityGate = {
  authorize() {
    throw new Error("sf project create cannot authorize a human identity");
  },
  verify() {
    return false;
  },
};

export interface RunProjectCreateOptions {
  readonly factoryDbPath?: string;
  readonly log?: (line: string) => void;
}

export async function runProjectCreate(
  key: string,
  name: string,
  options: RunProjectCreateOptions = {},
): Promise<Project> {
  const trimmedKey = key.trim();
  const trimmedName = name.trim();
  if (trimmedKey.length === 0) {
    throw new Error("project key must not be blank");
  }
  if (trimmedName.length === 0) {
    throw new Error("project name must not be blank");
  }

  const dbPath = options.factoryDbPath ?? process.env.FACTORY_DB_PATH ?? ".factory-data/factory.db";
  mkdirSync(dirname(dbPath), { recursive: true });

  const store = createSqliteStore(dbPath);
  try {
    const factory = new FactoryService({
      store,
      clock: systemClock,
      ids: createRandomIdGenerator(),
      identityGate: NO_IDENTITY_GATE,
      workerRegistry: createLocalWorkerRegistry(systemClock),
    });

    const project = await factory.createProject({ key, name });
    (options.log ?? console.log)(JSON.stringify(project));
    return project;
  } finally {
    store.close();
  }
}
