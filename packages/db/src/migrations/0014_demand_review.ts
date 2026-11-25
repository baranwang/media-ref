import { type Kysely, sql } from "kysely";

// A demand whose exploration submitted a change request now waits for that request to take
// effect (`awaiting_review`) instead of counting as fulfilled; `change_requests.demand_id`
// links the request back so approval fulfills the demand and rejection reopens it.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    alter table demands
      drop constraint demands_status_check,
      add constraint demands_status_check
        check (status in ('open', 'leased', 'awaiting_review', 'fulfilled', 'not_found', 'invalid_key'))
  `.execute(db);

  await sql`
    alter table change_requests
      add column demand_id uuid references demands (id) on delete set null
  `.execute(db);

  await sql`
    create index change_requests_demand_idx
    on change_requests (demand_id)
    where demand_id is not null
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop index if exists change_requests_demand_idx`.execute(db);
  await sql`alter table change_requests drop column if exists demand_id`.execute(db);
  await sql`update demands set status = 'open' where status = 'awaiting_review'`.execute(db);
  await sql`
    alter table demands
      drop constraint demands_status_check,
      add constraint demands_status_check
        check (status in ('open', 'leased', 'fulfilled', 'not_found', 'invalid_key'))
  `.execute(db);
}
