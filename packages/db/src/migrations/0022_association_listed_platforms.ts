import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // Platforms a Douban subject lists under "where to watch"; null = not fetched yet (#130).
  await sql`alter table associations add column listed_platforms text[]`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table associations drop column listed_platforms`.execute(db);
}
