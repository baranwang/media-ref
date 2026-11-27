import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // Older revisions never recorded a source ID. Equal snapshots or reasons cannot establish one.
  await db.schema
    .alterTable("association_revisions")
    .addColumn("restored_from_revision_id", "uuid", (col) =>
      col
        .references("association_revisions.id")
        .check(sql`restored_from_revision_id is null or status = 'confirmed'`),
    )
    .execute();

  await db.schema
    .createTable("review_corrections")
    .addColumn("change_request_id", "uuid", (col) =>
      col.primaryKey().references("change_requests.id"),
    )
    .addColumn("media_id", "uuid", (col) => col.references("media.id"))
    .addColumn("target_external_key", "text")
    .addColumn("namespace", "text", (col) => col.notNull().references("namespaces.namespace"))
    .addColumn("native_id", "text", (col) => col.notNull())
    .addCheckConstraint(
      "review_corrections_target_xor_chk",
      sql`num_nonnulls(media_id, target_external_key) = 1`,
    )
    .execute();

  await db.schema
    .createIndex("review_corrections_media_uidx")
    .unique()
    .on("review_corrections")
    .columns(["media_id", "namespace", "native_id"])
    .execute();
  await db.schema
    .createIndex("review_corrections_external_key_uidx")
    .unique()
    .on("review_corrections")
    .columns(["target_external_key", "namespace", "native_id"])
    .execute();

  // Only the latest verdict survives. Legacy leads carry no change-request ID and remain in leads.
  await sql`
    insert into review_corrections (change_request_id, media_id, target_external_key, namespace, native_id)
    select id, media_id, case when media_id is null then target_external_key end, namespace, native_id
    from change_requests
    where status = 'rejected' and reviewer_user_id = 'system:review-agent'
      and evidence #>> '{reviewAgent,verdict}' in ('reject_with_correction', 'revoke_with_correction')
    order by reviewed_at, id
    on conflict do nothing
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("review_corrections").execute();
  await db.schema
    .alterTable("association_revisions")
    .dropColumn("restored_from_revision_id")
    .execute();
}
