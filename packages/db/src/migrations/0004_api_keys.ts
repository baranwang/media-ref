import type { Kysely } from "kysely";

/**
 * Better Auth `@better-auth/api-key@1.7.27` PostgreSQL schema (generated via
 * `better-auth/db/migration` `getMigrations`).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("apikey")
    .addColumn("id", "text", (col) => col.primaryKey().notNull())
    .addColumn("configId", "text", (col) => col.notNull())
    .addColumn("name", "text")
    .addColumn("start", "text")
    .addColumn("referenceId", "text", (col) => col.notNull())
    .addColumn("prefix", "text")
    .addColumn("key", "text", (col) => col.notNull())
    .addColumn("refillInterval", "integer")
    .addColumn("refillAmount", "integer")
    .addColumn("lastRefillAt", "timestamptz")
    .addColumn("enabled", "boolean")
    .addColumn("rateLimitEnabled", "boolean")
    .addColumn("rateLimitTimeWindow", "integer")
    .addColumn("rateLimitMax", "integer")
    .addColumn("requestCount", "integer")
    .addColumn("remaining", "integer")
    .addColumn("lastRequest", "timestamptz")
    .addColumn("expiresAt", "timestamptz")
    .addColumn("createdAt", "timestamptz", (col) => col.notNull())
    .addColumn("updatedAt", "timestamptz", (col) => col.notNull())
    .addColumn("permissions", "text")
    .addColumn("metadata", "text")
    .execute();

  await db.schema.createIndex("apikey_configId_idx").on("apikey").column("configId").execute();
  await db.schema
    .createIndex("apikey_referenceId_idx")
    .on("apikey")
    .column("referenceId")
    .execute();
  await db.schema.createIndex("apikey_key_idx").on("apikey").column("key").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("apikey").ifExists().execute();
}
