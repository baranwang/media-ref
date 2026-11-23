import type { ColumnType, Generated } from "kysely";

export interface SchemaMetaTable {
  key: string;
  value: string;
  updated_at: Generated<Date>;
}

export type BackgroundJobStatus = "pending" | "leased" | "completed" | "failed";

export type JsonObject = Record<string, unknown>;

export interface BackgroundJobsTable {
  id: Generated<string>;
  job_type: string;
  dedupe_key: string | null;
  status: BackgroundJobStatus;
  priority: Generated<number>;
  payload: ColumnType<JsonObject, JsonObject | string | undefined, JsonObject | string>;
  result: ColumnType<
    JsonObject | null,
    JsonObject | string | null | undefined,
    JsonObject | string | null
  >;
  error_message: string | null;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  run_after: Generated<Date>;
  lease_generation: Generated<number>;
  lease_expires_at: Date | null;
  leased_at: Date | null;
  completed_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface Database {
  schema_meta: SchemaMetaTable;
  background_jobs: BackgroundJobsTable;
}
