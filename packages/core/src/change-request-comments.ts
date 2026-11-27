/**
 * Comments on change requests (ADR 0003 amendment 2): people take part by commenting, and each
 * comment queues a review agent session that reads it as a request, verifies it and replies.
 * A comment is evidence, not a decision: nothing here changes the change request.
 */

import type { Db } from "@media-ref/db";
import { sql } from "kysely";
import { isUuid, MediaServiceError } from "./media-service.ts";
import { enqueueReviewAgentJobInTx } from "./review-agent.ts";

export const MAX_COMMENT_LENGTH = 1000;
/** Comments one user may write per UTC day, across all change requests. */
export const COMMENT_DAILY_LIMIT = 20;

export type CommentErrorCode = "INVALID_COMMENT" | "COMMENT_LIMIT_REACHED";

export class CommentError extends Error {
  constructor(
    readonly code: CommentErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CommentError";
  }
}

export interface ChangeRequestCommentRecord {
  id: string;
  changeRequestId: string;
  authorUserId: string;
  authorName: string;
  content: string;
  replyToIds: string[];
  createdAt: string;
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Writes a person's comment and queues the change request's review (one job per request at a
 * time). While evidence is still being collected no job is queued: the review that follows the
 * evidence check reads the comment.
 */
export async function createChangeRequestComment(
  db: Db,
  input: { changeRequestId: string; authorUserId: string; content: string; now?: Date },
): Promise<ChangeRequestCommentRecord> {
  const content = input.content.trim();
  if (!content || content.length > MAX_COMMENT_LENGTH) {
    throw new CommentError(
      "INVALID_COMMENT",
      400,
      `Comment must be 1–${MAX_COMMENT_LENGTH} characters`,
    );
  }
  if (!isUuid(input.changeRequestId)) {
    throw new MediaServiceError("CHANGE_REQUEST_NOT_FOUND", 404, "Change request not found");
  }
  const now = input.now ?? new Date();
  return db.transaction().execute(async (trx) => {
    const cr = await trx
      .selectFrom("change_requests")
      .select(["id", "status"])
      .where("id", "=", input.changeRequestId)
      .executeTakeFirst();
    if (!cr) {
      throw new MediaServiceError("CHANGE_REQUEST_NOT_FOUND", 404, "Change request not found");
    }
    // Serializes one user's comments so concurrent ones cannot overshoot the cap.
    await sql`select pg_advisory_xact_lock(hashtext(${`comment:${input.authorUserId}`}))`.execute(
      trx,
    );
    const today = await trx
      .selectFrom("change_request_comments")
      .select(sql<string>`count(*)`.as("count"))
      .where("author_user_id", "=", input.authorUserId)
      .where("created_at", ">=", startOfUtcDay(now))
      .executeTakeFirstOrThrow();
    if (Number(today.count) >= COMMENT_DAILY_LIMIT) {
      throw new CommentError(
        "COMMENT_LIMIT_REACHED",
        429,
        `At most ${COMMENT_DAILY_LIMIT} comments per day`,
      );
    }
    const row = await trx
      .insertInto("change_request_comments")
      .values({
        change_request_id: cr.id,
        author_user_id: input.authorUserId,
        content,
        created_at: now,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    if (cr.status !== "pending_evidence") {
      await enqueueReviewAgentJobInTx(trx, { changeRequestId: cr.id, now });
    }
    const [record] = await listComments(trx, { changeRequestId: cr.id, id: row.id });
    return record!;
  });
}

/** The change request's comments and the agent's replies, oldest first. */
export async function listChangeRequestComments(
  db: Db,
  changeRequestId: string,
): Promise<ChangeRequestCommentRecord[]> {
  if (!isUuid(changeRequestId)) {
    return [];
  }
  return listComments(db, { changeRequestId });
}

function listComments(
  db: Db,
  input: { changeRequestId: string; id?: string },
): Promise<ChangeRequestCommentRecord[]> {
  let query = db
    .selectFrom("change_request_comments as c")
    .innerJoin("user as u", "u.id", "c.author_user_id")
    .select(["c.id", "c.author_user_id", "u.name", "c.content", "c.reply_to_ids", "c.created_at"])
    .where("c.change_request_id", "=", input.changeRequestId);
  if (input.id) {
    query = query.where("c.id", "=", input.id);
  }
  return query
    .orderBy("c.created_at")
    .orderBy("c.id")
    .execute()
    .then((rows) =>
      rows.map((r) => ({
        id: r.id,
        changeRequestId: input.changeRequestId,
        authorUserId: r.author_user_id,
        authorName: r.name,
        content: r.content,
        replyToIds: r.reply_to_ids,
        createdAt: r.created_at.toISOString(),
      })),
    );
}
