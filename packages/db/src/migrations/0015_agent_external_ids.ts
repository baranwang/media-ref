import { type Kysely, sql } from "kysely";

// The exploration agent writes missing external IDs directly (ADR 0002 §2.1), as `source = 'agent'`,
// so reviewers can filter and roll them back separately from sync, reviewer and submission rows.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    alter table associations
      drop constraint associations_source_check,
      add constraint associations_source_check
        check (source is null or source in ('sync', 'reviewer', 'submission', 'agent'))
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`update associations set source = null where source = 'agent'`.execute(db);
  await sql`
    alter table associations
      drop constraint associations_source_check,
      add constraint associations_source_check
        check (source is null or source in ('sync', 'reviewer', 'submission'))
  `.execute(db);
}
