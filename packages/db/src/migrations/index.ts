import type { Migration, MigrationProvider } from "kysely/migration";
import * as m0001Initial from "./0001_initial.ts";

export const migrations: Record<string, Migration> = {
  "0001_initial": m0001Initial,
};

export const staticMigrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations;
  },
};
