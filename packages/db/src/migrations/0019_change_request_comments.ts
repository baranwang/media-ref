import { type Kysely, sql } from "kysely";

// People take part by commenting on a change request; the review agent answers in the same thread
// (ADR 0003 amendment 2). `reply_to_ids` lists the comments an agent reply answers.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("change_request_comments")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("change_request_id", "uuid", (col) =>
      col.notNull().references("change_requests.id").onDelete("cascade"),
    )
    .addColumn("author_user_id", "text", (col) => col.notNull().references("user.id"))
    .addColumn("content", "text", (col) => col.notNull())
    .addColumn("reply_to_ids", sql`uuid[]`, (col) => col.notNull().defaultTo(sql`'{}'`))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex("change_request_comments_change_request_idx")
    .on("change_request_comments")
    .columns(["change_request_id", "created_at"])
    .execute();
  await db.schema
    .createIndex("change_request_comments_author_idx")
    .on("change_request_comments")
    .columns(["author_user_id", "created_at"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("change_request_comments").ifExists().execute();
}
