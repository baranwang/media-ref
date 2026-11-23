import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("background_jobs")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("job_type", "text", (col) => col.notNull())
    .addColumn("dedupe_key", "text")
    .addColumn("status", "text", (col) =>
      col.notNull().check(sql`status in ('pending', 'leased', 'completed', 'failed')`),
    )
    .addColumn("priority", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("payload", "jsonb", (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("result", "jsonb")
    .addColumn("error_message", "text")
    .addColumn("attempts", "integer", (col) =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`attempts >= 0`),
    )
    .addColumn("max_attempts", "integer", (col) =>
      col
        .notNull()
        .defaultTo(5)
        .check(sql`max_attempts > 0`),
    )
    .addColumn("run_after", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("lease_generation", "integer", (col) =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`lease_generation >= 0`),
    )
    .addColumn("lease_expires_at", "timestamptz")
    .addColumn("leased_at", "timestamptz")
    .addColumn("completed_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await sql`
    create index background_jobs_claim_due_idx
    on background_jobs (status, run_after, priority desc, created_at asc)
    where status in ('pending', 'leased')
  `.execute(db);

  await sql`
    create index background_jobs_lease_expiry_idx
    on background_jobs (lease_expires_at, priority desc, created_at asc)
    where status = 'leased'
  `.execute(db);

  await sql`
    create unique index background_jobs_active_dedupe_key_idx
    on background_jobs (dedupe_key)
    where dedupe_key is not null and status in ('pending', 'leased')
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("background_jobs").ifExists().execute();
}
