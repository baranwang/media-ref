import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("platform_checks")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("media_id", "uuid", (col) =>
      col.notNull().references("media.id").onDelete("cascade"),
    )
    .addColumn("platform", "text", (col) =>
      col.notNull().check(sql`platform in ('tencent', 'iqiyi', 'youku', 'bilibili', 'mgtv')`),
    )
    .addColumn("status", "text", (col) => col.notNull().check(sql`status in ('not_found')`))
    .addColumn("checked_at", "timestamptz", (col) => col.notNull())
    .addColumn("attempt_count", "integer", (col) =>
      col
        .notNull()
        .defaultTo(1)
        .check(sql`attempt_count >= 1`),
    )
    .addColumn("next_retry_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("platform_checks_media_platform_uidx", ["media_id", "platform"])
    .execute();

  await sql`
    create index platform_checks_next_retry_idx
    on platform_checks (next_retry_at)
    where next_retry_at is not null
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("platform_checks").ifExists().execute();
}
