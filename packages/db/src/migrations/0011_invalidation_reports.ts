import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("invalidation_reports")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("association_id", "uuid", (col) =>
      col.notNull().references("associations.id").onDelete("cascade"),
    )
    .addColumn("reporter_type", "text", (col) =>
      col.notNull().check(sql`reporter_type in ('user', 'api_key')`),
    )
    .addColumn("reporter_user_id", "text", (col) => col.references("user.id"))
    .addColumn("reporter_key_id", "text")
    .addColumn("reason", "text")
    .addColumn("recheck_job_id", "uuid", (col) => col.references("background_jobs.id"))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "invalidation_reports_reporter_chk",
      sql`(reporter_type = 'user' and reporter_user_id is not null) or (reporter_type = 'api_key' and reporter_key_id is not null)`,
    )
    .execute();

  await sql`
    create unique index invalidation_reports_open_api_key_uidx
    on invalidation_reports (association_id, reporter_key_id)
    where reporter_type = 'api_key' and recheck_job_id is null
  `.execute(db);

  await sql`
    create index invalidation_reports_assoc_open_idx
    on invalidation_reports (association_id, created_at)
    where recheck_job_id is null
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("invalidation_reports").ifExists().execute();
}
