import { type Kysely, sql } from "kysely";

// Reviews the review agent ran per UTC day (ADR 0003 §6), next to the exploration demand count
// and the shared model token total.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    alter table exploration_daily_budget add column review_consumed integer not null default 0
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table exploration_daily_budget drop column review_consumed`.execute(db);
}
