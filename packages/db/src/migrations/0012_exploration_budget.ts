import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("exploration_daily_budget")
    .addColumn("budget_date", "text", (col) =>
      col.primaryKey().check(sql`budget_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`),
    )
    .addColumn("consumed", "integer", (col) =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`consumed >= 0`),
    )
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable("tmdb_daily_export_ids")
    .addColumn("media_type", "text", (col) =>
      col.notNull().check(sql`media_type in ('movie', 'tv')`),
    )
    .addColumn("tmdb_id", "text", (col) => col.notNull().check(sql`length(btrim(tmdb_id)) > 0`))
    .addColumn("exported_date", "text", (col) =>
      col.notNull().check(sql`exported_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`),
    )
    .addPrimaryKeyConstraint("tmdb_daily_export_ids_pk", ["media_type", "tmdb_id"])
    .execute();

  await db.schema
    .createIndex("tmdb_daily_export_ids_type_date_idx")
    .on("tmdb_daily_export_ids")
    .columns(["media_type", "exported_date"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("tmdb_daily_export_ids").ifExists().execute();
  await db.schema.dropTable("exploration_daily_budget").ifExists().execute();
}
