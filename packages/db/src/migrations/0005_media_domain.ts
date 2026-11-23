import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("media")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("type", "text", (col) => col.notNull().check(sql`type in ('movie', 'tv')`))
    .addColumn("baseline", "text", (col) =>
      col.check(sql`baseline is null or baseline in ('tmdb', 'tvdb', 'imdb', 'bangumi', 'douban')`),
    )
    .addColumn("title", "text", (col) => col.notNull())
    .addColumn("original_title", "text")
    .addColumn("year", "integer")
    .addColumn("seasons", "jsonb", (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn("merged_into_media_id", "uuid", (col) =>
      col.references("media.id").onDelete("set null"),
    )
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await sql`
    create index media_merged_into_idx
    on media (merged_into_media_id)
    where merged_into_media_id is not null
  `.execute(db);

  await db.schema
    .createTable("external_ids")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("media_id", "uuid", (col) =>
      col.notNull().references("media.id").onDelete("cascade"),
    )
    .addColumn("namespace", "text", (col) =>
      col.notNull().check(sql`namespace in ('tmdb', 'imdb', 'tvdb', 'trakt')`),
    )
    .addColumn("native_id", "text", (col) => col.notNull())
    .addColumn("locked", "boolean", (col) => col.notNull().defaultTo(false))
    .addColumn("source", "text", (col) =>
      col
        .notNull()
        .defaultTo("sync")
        .check(sql`source in ('sync', 'reviewer', 'submission')`),
    )
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await sql`
    create unique index external_ids_namespace_native_id_uidx
    on external_ids (namespace, native_id)
  `.execute(db);

  await sql`
    create unique index external_ids_media_id_namespace_uidx
    on external_ids (media_id, namespace)
  `.execute(db);

  await db.schema
    .createTable("variants")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("media_id", "uuid", (col) =>
      col.notNull().references("media.id").onDelete("cascade"),
    )
    .addColumn("platform", "text", (col) =>
      col.notNull().check(sql`platform in ('tencent', 'iqiyi', 'youku', 'bilibili', 'mgtv')`),
    )
    .addColumn("description", "text", (col) => col.notNull())
    .addColumn("is_default", "boolean", (col) => col.notNull().defaultTo(false))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await sql`
    create unique index variants_default_per_media_platform_uidx
    on variants (media_id, platform)
    where is_default = true
  `.execute(db);

  await db.schema
    .createIndex("variants_media_platform_idx")
    .on("variants")
    .columns(["media_id", "platform"])
    .execute();

  await db.schema
    .createTable("associations")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("media_id", "uuid", (col) =>
      col.notNull().references("media.id").onDelete("cascade"),
    )
    .addColumn("namespace", "text", (col) =>
      col
        .notNull()
        .check(
          sql`namespace in ('tencent', 'iqiyi', 'youku', 'bilibili', 'mgtv', 'douban', 'bangumi')`,
        ),
    )
    .addColumn("native_id", "text", (col) => col.notNull())
    .addColumn("variant_id", "uuid", (col) => col.references("variants.id").onDelete("restrict"))
    .addColumn("status", "text", (col) =>
      col.notNull().check(sql`status in ('confirmed', 'seed_unconfirmed', 'delisted')`),
    )
    .addColumn("needs_review", "boolean", (col) => col.notNull().defaultTo(false))
    .addColumn("locked", "boolean", (col) => col.notNull().defaultTo(false))
    .addColumn("current_revision_id", "uuid")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "associations_variant_namespace_chk",
      sql`(namespace in ('tencent', 'iqiyi', 'youku', 'bilibili', 'mgtv') and variant_id is not null) or (namespace in ('douban', 'bangumi') and variant_id is null)`,
    )
    .execute();

  await sql`
    create unique index associations_media_namespace_native_uidx
    on associations (media_id, namespace, native_id)
  `.execute(db);

  await db.schema
    .createIndex("associations_namespace_native_idx")
    .on("associations")
    .columns(["namespace", "native_id"])
    .execute();

  await sql`
    create index associations_variant_idx
    on associations (variant_id)
    where variant_id is not null
  `.execute(db);

  await db.schema
    .createIndex("associations_media_status_idx")
    .on("associations")
    .columns(["media_id", "status"])
    .execute();

  await db.schema
    .createTable("association_revisions")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("association_id", "uuid", (col) =>
      col.notNull().references("associations.id").onDelete("cascade"),
    )
    .addColumn("revision_number", "integer", (col) =>
      col.notNull().check(sql`revision_number >= 1`),
    )
    .addColumn("change_request_id", "uuid")
    .addColumn("variant_id", "uuid", (col) => col.references("variants.id").onDelete("set null"))
    .addColumn("status", "text", (col) =>
      col.notNull().check(sql`status in ('confirmed', 'seed_unconfirmed', 'delisted')`),
    )
    .addColumn("segments", "jsonb", (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn("actor_user_id", "text", (col) => col.references("user.id").onDelete("set null"))
    .addColumn("reason", "text")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await sql`
    create unique index association_revisions_assoc_rev_uidx
    on association_revisions (association_id, revision_number)
  `.execute(db);

  await db.schema
    .createTable("segments")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("association_id", "uuid", (col) =>
      col.notNull().references("associations.id").onDelete("cascade"),
    )
    .addColumn("season", "integer", (col) => col.notNull().check(sql`season >= 0`))
    .addColumn("episode_start", "integer", (col) => col.notNull().check(sql`episode_start >= 1`))
    .addColumn("episode_end", "integer", (col) =>
      col.check(sql`episode_end is null or episode_end >= episode_start`),
    )
    .addColumn("target_episode_start", "integer", (col) =>
      col.notNull().check(sql`target_episode_start >= 1`),
    )
    .addColumn("baseline", "text", (col) =>
      col.notNull().check(sql`baseline in ('tmdb', 'tvdb', 'imdb', 'bangumi', 'douban')`),
    )
    .addColumn("non_linear", "boolean", (col) => col.notNull().defaultTo(false))
    .addColumn("needs_review", "boolean", (col) => col.notNull().defaultTo(false))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex("segments_association_idx")
    .on("segments")
    .columns(["association_id", "season", "episode_start"])
    .execute();

  await db.schema
    .createTable("change_requests")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("status", "text", (col) =>
      col
        .notNull()
        .check(sql`status in ('pending_evidence', 'approved', 'needs_review', 'rejected')`),
    )
    .addColumn("submitter_user_id", "text", (col) =>
      col.notNull().references("user.id").onDelete("restrict"),
    )
    .addColumn("submitter_key_id", "text")
    .addColumn("submitter_type", "text", (col) =>
      col
        .notNull()
        .defaultTo("human")
        .check(sql`submitter_type in ('human', 'agent')`),
    )
    .addColumn("task_id", "uuid")
    .addColumn("media_id", "uuid", (col) => col.references("media.id").onDelete("set null"))
    .addColumn("target_external_key", "text", (col) => col.notNull())
    .addColumn("namespace", "text", (col) =>
      col
        .notNull()
        .check(
          sql`namespace in ('tencent', 'iqiyi', 'youku', 'bilibili', 'mgtv', 'douban', 'bangumi')`,
        ),
    )
    .addColumn("raw_native_id", "text", (col) => col.notNull())
    .addColumn("native_id", "text", (col) => col.notNull())
    .addColumn("variant_id", "uuid", (col) => col.references("variants.id").onDelete("set null"))
    .addColumn("variant_description", "text")
    .addColumn("set_default_variant", "boolean", (col) => col.notNull().defaultTo(false))
    .addColumn("segments", "jsonb", (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn("evidence", "jsonb")
    .addColumn("conflict_reason", "text")
    .addColumn("decision_reason", "text")
    .addColumn("reviewer_user_id", "text", (col) => col.references("user.id").onDelete("set null"))
    .addColumn("reviewed_at", "timestamptz")
    .addColumn("applied_association_id", "uuid", (col) =>
      col.references("associations.id").onDelete("set null"),
    )
    .addColumn("applied_revision_id", "uuid", (col) =>
      col.references("association_revisions.id").onDelete("set null"),
    )
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex("change_requests_status_created_idx")
    .on("change_requests")
    .columns(["status", "created_at"])
    .execute();

  await db.schema
    .createIndex("change_requests_submitter_created_idx")
    .on("change_requests")
    .columns(["submitter_user_id", "created_at"])
    .execute();

  await sql`
    create index change_requests_media_idx
    on change_requests (media_id)
    where media_id is not null
  `.execute(db);

  await sql`
    create unique index change_requests_task_id_uidx
    on change_requests (task_id)
    where task_id is not null
  `.execute(db);

  await sql`
    alter table associations
    add constraint associations_current_revision_id_fk
    foreign key (current_revision_id) references association_revisions (id) on delete set null
  `.execute(db);

  await sql`
    alter table association_revisions
    add constraint association_revisions_change_request_id_fk
    foreign key (change_request_id) references change_requests (id) on delete set null
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table if exists associations drop constraint if exists associations_current_revision_id_fk`.execute(
    db,
  );
  await sql`alter table if exists association_revisions drop constraint if exists association_revisions_change_request_id_fk`.execute(
    db,
  );
  await db.schema.dropTable("change_requests").ifExists().execute();
  await db.schema.dropTable("segments").ifExists().execute();
  await db.schema.dropTable("association_revisions").ifExists().execute();
  await db.schema.dropTable("associations").ifExists().execute();
  await db.schema.dropTable("variants").ifExists().execute();
  await db.schema.dropTable("external_ids").ifExists().execute();
  await db.schema.dropTable("media").ifExists().execute();
}
