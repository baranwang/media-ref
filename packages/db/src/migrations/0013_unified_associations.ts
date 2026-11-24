import { type Kysely, sql } from "kysely";

// Mirrors NAMESPACE_CAPABILITIES in @media-ref/client (ADR 0001). Frozen here: later namespaces get their own migration.
const NAMESPACE_ROWS = [
  ["tencent", "platform", true, false, "evidence"],
  ["iqiyi", "platform", true, false, "evidence"],
  ["youku", "platform", true, false, "evidence"],
  ["bilibili", "platform", true, false, "evidence"],
  ["mgtv", "platform", true, false, "evidence"],
  ["tmdb", "catalog", false, true, "sync"],
  ["imdb", "catalog", false, true, "sync"],
  ["tvdb", "catalog", false, true, "sync"],
  ["trakt", "catalog", false, true, "sync"],
  ["douban", "catalog", false, false, "evidence"],
  ["bangumi", "catalog", false, false, "evidence"],
] as const;

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("namespaces")
    .addColumn("namespace", "text", (col) => col.primaryKey())
    .addColumn("namespace_group", "text", (col) =>
      col.notNull().check(sql`namespace_group in ('platform', 'catalog')`),
    )
    .addColumn("supports_variants", "boolean", (col) => col.notNull())
    .addColumn("allow_hierarchical_scopes", "boolean", (col) => col.notNull())
    .addColumn("verification_mode", "text", (col) =>
      col.notNull().check(sql`verification_mode in ('sync', 'evidence')`),
    )
    // Target of the (namespace, has_variant) foreign key on associations.
    .addUniqueConstraint("namespaces_namespace_supports_variants_uq", [
      "namespace",
      "supports_variants",
    ])
    .execute();

  await db
    .insertInto("namespaces")
    .values(
      NAMESPACE_ROWS.map(([namespace, group, supportsVariants, hierarchical, verification]) => ({
        namespace,
        namespace_group: group,
        supports_variants: supportsVariants,
        allow_hierarchical_scopes: hierarchical,
        verification_mode: verification,
      })),
    )
    .execute();

  await sql`
    alter table associations
      drop constraint associations_namespace_check,
      drop constraint associations_variant_namespace_chk,
      add column title text,
      add column episode_count integer check (episode_count is null or episode_count >= 0),
      add column is_external_id boolean not null default false,
      add column source text check (source is null or source in ('sync', 'reviewer', 'submission')),
      add column has_variant boolean generated always as (variant_id is not null) stored,
      add constraint associations_namespace_fk
        foreign key (namespace, has_variant) references namespaces (namespace, supports_variants),
      add constraint associations_external_id_chk
        check (not is_external_id or variant_id is null)
  `.execute(db);

  await sql`
    create unique index associations_external_id_namespace_native_uidx
    on associations (namespace, native_id)
    where is_external_id
  `.execute(db);

  await sql`
    create unique index associations_external_id_media_namespace_uidx
    on associations (media_id, namespace)
    where is_external_id
  `.execute(db);

  await sql`
    insert into associations
      (media_id, namespace, native_id, variant_id, status, locked, is_external_id, source, created_at, updated_at)
    select media_id, namespace, native_id, null, 'confirmed', locked, true, source, created_at, updated_at
    from external_ids
  `.execute(db);

  await db.schema.dropTable("external_ids").execute();

  await sql`
    alter table change_requests
      drop constraint change_requests_namespace_check,
      add constraint change_requests_namespace_fk foreign key (namespace) references namespaces (namespace)
  `.execute(db);

  await sql`
    alter table variants
      drop constraint variants_platform_check,
      add constraint variants_platform_fk foreign key (platform) references namespaces (namespace)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    alter table variants
      drop constraint variants_platform_fk,
      add constraint variants_platform_check
        check (platform in ('tencent', 'iqiyi', 'youku', 'bilibili', 'mgtv'))
  `.execute(db);

  await sql`
    alter table change_requests
      drop constraint change_requests_namespace_fk,
      add constraint change_requests_namespace_check
        check (namespace in ('tencent', 'iqiyi', 'youku', 'bilibili', 'mgtv', 'douban', 'bangumi'))
  `.execute(db);

  await sql`
    create table external_ids (
      id uuid primary key default gen_random_uuid(),
      media_id uuid not null references media (id) on delete cascade,
      namespace text not null check (namespace in ('tmdb', 'imdb', 'tvdb', 'trakt')),
      native_id text not null,
      locked boolean not null default false,
      source text not null default 'sync' check (source in ('sync', 'reviewer', 'submission')),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create unique index external_ids_namespace_native_id_uidx on external_ids (namespace, native_id)`.execute(
    db,
  );
  await sql`create unique index external_ids_media_id_namespace_uidx on external_ids (media_id, namespace)`.execute(
    db,
  );
  await sql`
    insert into external_ids (media_id, namespace, native_id, locked, source, created_at, updated_at)
    select media_id, namespace, native_id, locked, source, created_at, updated_at
    from associations where is_external_id
  `.execute(db);

  // Season/episode associations on authority catalogs have no home in the old schema.
  await sql`delete from associations where namespace in ('tmdb', 'imdb', 'tvdb', 'trakt')`.execute(
    db,
  );

  await sql`
    alter table associations
      drop constraint associations_namespace_fk,
      drop constraint associations_external_id_chk,
      drop column has_variant,
      drop column source,
      drop column is_external_id,
      drop column episode_count,
      drop column title,
      add constraint associations_namespace_check
        check (namespace in ('tencent', 'iqiyi', 'youku', 'bilibili', 'mgtv', 'douban', 'bangumi')),
      add constraint associations_variant_namespace_chk check (
        (namespace in ('tencent', 'iqiyi', 'youku', 'bilibili', 'mgtv') and variant_id is not null)
        or (namespace in ('douban', 'bangumi') and variant_id is null)
      )
  `.execute(db);

  await db.schema.dropTable("namespaces").execute();
}
