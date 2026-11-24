import { Kysely, PostgresDialect } from "kysely";
import { Pool, type PoolConfig } from "pg";
import type { Database } from "./schema.ts";

export type Db = Kysely<Database>;

export interface CreateDbOptions {
  max?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  onError?: (error: Error) => void;
}

export function createDb(connectionString: string, options: CreateDbOptions = {}): Db {
  const { onError, ...poolOptions } = options;
  const poolConfig: PoolConfig = {
    connectionString,
    ...poolOptions,
  };
  const pool = new Pool(poolConfig);
  pool.on("error", (error) => {
    onError?.(error);
  });

  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
}
