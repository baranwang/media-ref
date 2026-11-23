import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("leads")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("target_external_key", "text", (col) => col.notNull())
    .addColumn("namespace", "text", (col) => col.notNull())
    .addColumn("native_id", "text", (col) => col.notNull())
    .addColumn("season", "integer", (col) => col.check(sql`season is null or season >= 0`))
    .addColumn("variant_description", "text")
    .addColumn("notes", "text")
    .addColumn("reporter_user_id", "text", (col) => col.notNull().references("user.id"))
    .addColumn("reporter_key_id", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex("leads_target_external_key_namespace_season_idx")
    .on("leads")
    .columns(["target_external_key", "namespace", "season"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("leads").ifExists().execute();
}
