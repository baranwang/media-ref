import { Migrator, type MigrationResult } from "kysely/migration";
import type { Db } from "./client.ts";
import { staticMigrationProvider } from "./migrations/index.ts";

export async function runMigrations(db: Db): Promise<MigrationResult[]> {
  const migrator = new Migrator({
    db,
    provider: staticMigrationProvider,
  });

  const { error, results } = await migrator.migrateToLatest();

  if (error) {
    const failed = results?.find((entry) => entry.status === "Error");
    const detail = failed ? ` (failed at ${failed.migrationName})` : "";
    throw new Error(`Database migration failed${detail}`, { cause: error });
  }

  return results ?? [];
}
