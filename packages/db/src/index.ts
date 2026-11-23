export { createDb, type CreateDbOptions, type Db } from "./client.ts";
export { migrations, staticMigrationProvider } from "./migrations/index.ts";
export { runMigrations } from "./migrator.ts";
export type {
  BackgroundJobStatus,
  BackgroundJobsTable,
  Database,
  JsonObject,
  SchemaMetaTable,
} from "./schema.ts";
export {
  createTestDb,
  DEFAULT_TEST_ADMIN_URL,
  type CreateTestDbOptions,
  type TestDbHandle,
} from "./testing.ts";
