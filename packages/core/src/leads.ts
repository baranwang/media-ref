import { isNamespace, parseExternalKey, type Namespace } from "@media-ref/client";
import type { Database, Db } from "@media-ref/db";
import type { Selectable } from "kysely";

export const MAX_LEAD_NATIVE_ID_LENGTH = 512;
export const MAX_LEAD_VARIANT_DESCRIPTION_LENGTH = 512;
export const MAX_LEAD_NOTES_LENGTH = 4000;

const MAX_PG_INT32 = 2_147_483_647;

export type LeadValidationErrorCode =
  | "INVALID_EXTERNAL_KEY"
  | "INVALID_NAMESPACE"
  | "INVALID_NATIVE_ID"
  | "INVALID_SEASON"
  | "INVALID_VARIANT_DESCRIPTION"
  | "INVALID_NOTES"
  | "INVALID_REPORTER";

export class LeadValidationError extends Error {
  readonly code: LeadValidationErrorCode;

  constructor(code: LeadValidationErrorCode, message: string) {
    super(message);
    this.name = "LeadValidationError";
    this.code = code;
  }
}

export interface Lead {
  id: string;
  targetExternalKey: string;
  namespace: Namespace;
  nativeId: string;
  season: number | null;
  variantDescription: string | null;
  notes: string | null;
  reporterUserId: string;
  reporterKeyId: string;
  createdAt: Date;
}

export interface RecordLeadInput {
  targetExternalKey: string;
  namespace: string;
  nativeId: string;
  season?: number | null;
  variantDescription?: string | null;
  notes?: string | null;
  reporterUserId: string;
  reporterKeyId: string;
}

export interface ListLeadsForTargetQuery {
  targetExternalKey: string;
  namespace?: Namespace;
  season?: number | null;
  limit?: number;
}

type LeadRow = Selectable<Database["leads"]>;

function mapLeadRow(row: LeadRow): Lead {
  return {
    id: row.id,
    targetExternalKey: row.target_external_key,
    namespace: row.namespace as Namespace,
    nativeId: row.native_id,
    season: row.season,
    variantDescription: row.variant_description,
    notes: row.notes,
    reporterUserId: row.reporter_user_id,
    reporterKeyId: row.reporter_key_id,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  };
}

function normalizeOptionalText(
  value: unknown,
  maxLength: number,
  code: "INVALID_VARIANT_DESCRIPTION" | "INVALID_NOTES",
  fieldName: string,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new LeadValidationError(code, `${fieldName} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > maxLength) {
    throw new LeadValidationError(code, `${fieldName} must be at most ${maxLength} characters`);
  }
  return trimmed;
}

/**
 * Records a client-reported Lead for future Exploration reference.
 * Intentionally decoupled from media/associations/change requests and never enqueues background jobs.
 */
export async function recordLead(dbWrite: Db, input: RecordLeadInput): Promise<Lead> {
  if (typeof input.targetExternalKey !== "string" || !parseExternalKey(input.targetExternalKey)) {
    throw new LeadValidationError(
      "INVALID_EXTERNAL_KEY",
      "targetExternalKey must be a valid external key in '<namespace>:<nativeId>' format",
    );
  }

  if (typeof input.namespace !== "string" || !isNamespace(input.namespace)) {
    throw new LeadValidationError(
      "INVALID_NAMESPACE",
      "namespace must be a valid platform or catalog namespace",
    );
  }

  if (typeof input.nativeId !== "string") {
    throw new LeadValidationError("INVALID_NATIVE_ID", "nativeId must be a non-empty string");
  }
  const nativeId = input.nativeId.trim();
  if (nativeId.length === 0 || nativeId.length > MAX_LEAD_NATIVE_ID_LENGTH) {
    throw new LeadValidationError(
      "INVALID_NATIVE_ID",
      `nativeId must be between 1 and ${MAX_LEAD_NATIVE_ID_LENGTH} characters`,
    );
  }

  let season: number | null = null;
  if (input.season !== undefined && input.season !== null) {
    if (
      typeof input.season !== "number" ||
      !Number.isInteger(input.season) ||
      input.season < 0 ||
      input.season > MAX_PG_INT32
    ) {
      throw new LeadValidationError("INVALID_SEASON", "season must be a non-negative integer");
    }
    season = input.season;
  }

  const variantDescription = normalizeOptionalText(
    input.variantDescription,
    MAX_LEAD_VARIANT_DESCRIPTION_LENGTH,
    "INVALID_VARIANT_DESCRIPTION",
    "variantDescription",
  );
  const notes = normalizeOptionalText(input.notes, MAX_LEAD_NOTES_LENGTH, "INVALID_NOTES", "notes");

  const reporterUserId =
    typeof input.reporterUserId === "string" ? input.reporterUserId.trim() : "";
  const reporterKeyId = typeof input.reporterKeyId === "string" ? input.reporterKeyId.trim() : "";
  if (reporterUserId.length === 0 || reporterKeyId.length === 0) {
    throw new LeadValidationError(
      "INVALID_REPORTER",
      "reporterUserId and reporterKeyId must be non-empty strings",
    );
  }

  const inserted = await dbWrite
    .insertInto("leads")
    .values({
      target_external_key: input.targetExternalKey,
      namespace: input.namespace,
      native_id: nativeId,
      season,
      variant_description: variantDescription,
      notes,
      reporter_user_id: reporterUserId,
      reporter_key_id: reporterKeyId,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return mapLeadRow(inserted);
}

/**
 * Lists stored Leads matching a target external key (and optional namespace / season)
 * for Exploration agents to consult as reference hints.
 */
export async function listLeadsForTarget(db: Db, query: ListLeadsForTargetQuery): Promise<Lead[]> {
  if (typeof query.targetExternalKey !== "string" || !parseExternalKey(query.targetExternalKey)) {
    return [];
  }

  if (query.namespace !== undefined && !isNamespace(query.namespace)) {
    return [];
  }

  if (
    typeof query.season === "number" &&
    (!Number.isInteger(query.season) || query.season < 0 || query.season > MAX_PG_INT32)
  ) {
    return [];
  }

  let select = db
    .selectFrom("leads")
    .selectAll()
    .where("target_external_key", "=", query.targetExternalKey);

  if (query.namespace !== undefined) {
    select = select.where("namespace", "=", query.namespace);
  }

  if (query.season === null) {
    select = select.where("season", "is", null);
  } else if (query.season !== undefined) {
    select = select.where("season", "=", query.season);
  }

  select = select.orderBy("created_at", "desc").orderBy("id", "desc");

  if (query.limit !== undefined) {
    if (!Number.isInteger(query.limit) || query.limit <= 0) {
      return [];
    }
    select = select.limit(query.limit);
  }

  const rows = await select.execute();
  return rows.map(mapLeadRow);
}
