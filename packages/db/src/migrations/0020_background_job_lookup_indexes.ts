import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    create index background_jobs_dedupe_key_idx
    on background_jobs (dedupe_key) where dedupe_key is not null
  `.execute(db);

  await sql`
    create index background_jobs_completed_by_type_idx
    on background_jobs (job_type, completed_at desc) where status = 'completed'
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop index background_jobs_completed_by_type_idx`.execute(db);
  await sql`drop index background_jobs_dedupe_key_idx`.execute(db);
}
