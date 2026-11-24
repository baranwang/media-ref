import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("demands")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("media_id", "uuid", (col) => col.references("media.id").onDelete("cascade"))
    .addColumn("external_key", "text", (col) =>
      col.check(sql`external_key is null or length(btrim(external_key)) > 0`),
    )
    .addColumn("season", "integer", (col) => col.check(sql`season is null or season >= 0`))
    .addColumn("namespace_group", "text", (col) =>
      col.notNull().check(sql`namespace_group in ('platform', 'catalog')`),
    )
    .addColumn("demand_count", "integer", (col) =>
      col
        .notNull()
        .defaultTo(1)
        .check(sql`demand_count >= 1`),
    )
    .addColumn("status", "text", (col) =>
      col
        .notNull()
        .defaultTo("open")
        .check(sql`status in ('open', 'leased', 'fulfilled', 'not_found', 'invalid_key')`),
    )
    .addColumn("not_found_count", "integer", (col) =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`not_found_count >= 0`),
    )
    .addColumn("next_eligible_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("last_explored_at", "timestamptz")
    .addColumn("lease_generation", "integer", (col) =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`lease_generation >= 0`),
    )
    .addColumn("lease_expires_at", "timestamptz")
    .addColumn("last_demanded_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "demands_target_xor_chk",
      sql`(media_id is not null and external_key is null) or (media_id is null and external_key is not null)`,
    )
    .execute();

  await sql`
    create unique index demands_media_season_group_uidx
    on demands (media_id, coalesce(season, -1), namespace_group)
    where media_id is not null
  `.execute(db);

  await sql`
    create unique index demands_extkey_season_group_uidx
    on demands (external_key, coalesce(season, -1), namespace_group)
    where media_id is null
  `.execute(db);

  await sql`
    create index demands_scheduling_idx
    on demands (status, next_eligible_at, demand_count desc, last_demanded_at desc)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("demands").ifExists().execute();
}
