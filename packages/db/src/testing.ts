import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { createDb, type Db } from "./client.ts";
import { runMigrations } from "./migrator.ts";

export const DEFAULT_TEST_ADMIN_URL = "postgres://postgres:postgres@127.0.0.1:54329/postgres";

export interface CreateTestDbOptions {
  adminUrl?: string;
  migrate?: boolean;
}

export interface TestDbHandle {
  db: Db;
  readDb: Db;
  writeDb: Db;
  connectionString: string;
  dbName: string;
  cleanup: () => Promise<void>;
}

const VALID_DB_NAME = /^[a-z0-9_]+$/;

function buildDatabaseUrl(adminUrl: string, dbName: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

async function withAdminClient<T>(
  adminUrl: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function createTestDb(options: CreateTestDbOptions = {}): Promise<TestDbHandle> {
  const adminUrl = options.adminUrl ?? process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_ADMIN_URL;
  const dbName = `media_ref_test_${randomBytes(8).toString("hex")}`;

  if (!VALID_DB_NAME.test(dbName)) {
    throw new Error(`Invalid ephemeral database name: ${dbName}`);
  }

  await withAdminClient(adminUrl, async (client) => {
    await client.query(`CREATE DATABASE "${dbName}"`);
  });

  const connectionString = buildDatabaseUrl(adminUrl, dbName);
  const readDb = createDb(connectionString);
  const writeDb = createDb(connectionString);
  let cleanedUp = false;

  const cleanup = async (): Promise<void> => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;

    await Promise.allSettled([readDb.destroy(), writeDb.destroy()]);
    await withAdminClient(adminUrl, async (client) => {
      await client.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    });
  };

  if (options.migrate !== false) {
    try {
      await runMigrations(writeDb);
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  return {
    db: writeDb,
    readDb,
    writeDb,
    connectionString,
    dbName,
    cleanup,
  };
}
