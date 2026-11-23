import { createDb } from "./client.ts";
import { runMigrations } from "./migrator.ts";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required to run migrations");
  }

  const db = createDb(databaseUrl);
  try {
    const results = await runMigrations(db);
    if (results.length === 0) {
      console.log("No pending migrations.");
      return;
    }

    for (const entry of results) {
      console.log(`[${entry.status}] ${entry.direction} ${entry.migrationName}`);
    }
  } finally {
    await db.destroy();
  }
}

await main();
