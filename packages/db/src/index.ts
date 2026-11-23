export { createDb, type CreateDbOptions, type Db } from "./client.ts";
export { migrations, staticMigrationProvider } from "./migrations/index.ts";
export { runMigrations } from "./migrator.ts";
export type {
  AccountTable,
  ApiKeyTable,
  BackgroundJobStatus,
  BackgroundJobsTable,
  Database,
  JsonObject,
  LeadsTable,
  SchemaMetaTable,
  SessionTable,
  UserTable,
  VerificationTable,
} from "./schema.ts";
export {
  createTestDb,
  DEFAULT_TEST_ADMIN_URL,
  type CreateTestDbOptions,
  type TestDbHandle,
} from "./testing.ts";
