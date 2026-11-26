import { type Kysely, sql } from "kysely";

// Model tokens the exploration agent spent per UTC day, next to the demand count (ADR 0002 §5),
// and that day's totals per model, which tokens.ci needs whole on every submission (it keeps the
// latest value per device and day, it does not add).
// bigint: the daily cap is around 1e9, close to int4's limit.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    alter table exploration_daily_budget
      add column tokens_used bigint not null default 0,
      add column pi_usage jsonb not null default '{}'
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    alter table exploration_daily_budget drop column tokens_used, drop column pi_usage
  `.execute(db);
}
