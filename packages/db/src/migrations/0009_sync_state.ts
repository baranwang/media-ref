import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("sync_state")
    .addColumn("sync_key", "text", (col) => col.primaryKey())
    .addColumn("last_synced_date", "text", (col) =>
      col.notNull().check(sql`last_synced_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`),
    )
    .addColumn("metadata", "jsonb", (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable("review_alerts")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("alert_type", "text", (col) =>
      col.notNull().check(sql`length(trim(alert_type)) > 0`),
    )
    .addColumn("media_id", "uuid", (col) => col.references("media.id").onDelete("cascade"))
    .addColumn("association_id", "uuid", (col) =>
      col.references("associations.id").onDelete("cascade"),
    )
    .addColumn("status", "text", (col) =>
      col
        .notNull()
        .defaultTo("open")
        .check(sql`status in ('open', 'resolved')`),
    )
    .addColumn("details", "jsonb", (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("resolved_at", "timestamptz")
    .addColumn("resolved_by_user_id", "text", (col) =>
      col.references("user.id").onDelete("set null"),
    )
    .execute();

  await db.schema
    .createIndex("review_alerts_status_created_idx")
    .on("review_alerts")
    .columns(["status", "created_at"])
    .execute();

  await db.schema
    .createIndex("review_alerts_media_type_status_idx")
    .on("review_alerts")
    .columns(["media_id", "alert_type", "status"])
    .execute();

  await sql`
    create index segments_needs_review_idx
    on segments (association_id, season)
    where needs_review = true
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop index if exists segments_needs_review_idx`.execute(db);
  await db.schema.dropTable("review_alerts").ifExists().execute();
  await db.schema.dropTable("sync_state").ifExists().execute();
}
