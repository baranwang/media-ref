import { Kysely, PostgresDialect } from "kysely";
import { Pool, type PoolConfig } from "pg";
import type { Database } from "./schema.ts";

export type Db = Kysely<Database>;

export interface CreateDbOptions {
  max?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
}

export function createDb(connectionString: string, options: CreateDbOptions = {}): Db {
  const poolConfig: PoolConfig = {
    connectionString,
    ...options,
  };
  const pool = new Pool(poolConfig);

  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
}
