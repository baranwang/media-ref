import { type Kysely, sql } from "kysely";

// A review agent correction (ADR 0003 §4) carries its corrected segments to the exploration
// agent on the lead it writes; client leads have none.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`alter table leads add column segments jsonb`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table leads drop column segments`.execute(db);
}
