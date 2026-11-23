import type { Migration, MigrationProvider } from "kysely/migration";
import * as m0001Initial from "./0001_initial.ts";
import * as m0002Auth from "./0002_auth.ts";
import * as m0003BackgroundJobs from "./0003_background_jobs.ts";
import * as m0004ApiKeys from "./0004_api_keys.ts";

export const migrations: Record<string, Migration> = {
  "0001_initial": m0001Initial,
  "0002_auth": m0002Auth,
  "0003_background_jobs": m0003BackgroundJobs,
  "0004_api_keys": m0004ApiKeys,
};

export const staticMigrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations;
  },
};
