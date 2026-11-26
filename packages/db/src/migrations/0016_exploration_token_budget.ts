import { type Kysely, sql } from "kysely";

// Model tokens the exploration agent spent per UTC day, next to the demand count (ADR 0002 §5),
// and per tokens.ci day and model, which is what gets submitted there as client "pi".
// bigint: the daily cap is around 1e9, close to int4's limit.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    alter table exploration_daily_budget add column tokens_used bigint not null default 0
  `.execute(db);
  await sql`
    create table pi_token_usage (
      day text not null,
      model text not null,
      input bigint not null default 0,
      output bigint not null default 0,
      cache_read bigint not null default 0,
      cache_write bigint not null default 0,
      messages bigint not null default 0,
      primary key (day, model)
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop table pi_token_usage`.execute(db);
  await sql`alter table exploration_daily_budget drop column tokens_used`.execute(db);
}
