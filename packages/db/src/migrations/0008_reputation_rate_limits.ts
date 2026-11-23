import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("user")
    .addColumn("reputation", "integer", (col) => col.notNull().defaultTo(0))
    .execute();

  await sql`drop index if exists change_requests_submitter_created_idx`.execute(db);
  await sql`
    create index change_requests_submitter_created_idx
    on change_requests (submitter_user_id, created_at desc)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop index if exists change_requests_submitter_created_idx`.execute(db);
  await db.schema
    .createIndex("change_requests_submitter_created_idx")
    .on("change_requests")
    .columns(["submitter_user_id", "created_at"])
    .execute();

  await db.schema.alterTable("user").dropColumn("reputation").execute();
}
