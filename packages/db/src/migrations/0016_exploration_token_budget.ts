import { type Kysely, sql } from "kysely";

// Model tokens the exploration agent spent per UTC day, next to the demand count (ADR 0002 §5).
// bigint: the daily cap is around 1e9, close to int4's limit.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    alter table exploration_daily_budget add column tokens_used bigint not null default 0
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table exploration_daily_budget drop column tokens_used`.execute(db);
}
