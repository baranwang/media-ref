import type { Migration, MigrationProvider } from "kysely/migration";
import * as m0001Initial from "./0001_initial.ts";
import * as m0003BackgroundJobs from "./0003_background_jobs.ts";

export const migrations: Record<string, Migration> = {
  "0001_initial": m0001Initial,
  "0003_background_jobs": m0003BackgroundJobs,
};

export const staticMigrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations;
  },
};
