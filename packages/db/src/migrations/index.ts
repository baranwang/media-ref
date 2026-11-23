import type { Migration, MigrationProvider } from "kysely/migration";
import * as m0001Initial from "./0001_initial.ts";
import * as m0002Auth from "./0002_auth.ts";

export const migrations: Record<string, Migration> = {
  "0001_initial": m0001Initial,
  "0002_auth": m0002Auth,
};

export const staticMigrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations;
  },
};
