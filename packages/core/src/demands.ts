import {
  formatExternalKey,
  getNamespaceGroup,
  isPlatformNamespace,
  parseExternalKey,
  PLATFORM_NAMESPACES,
  type Association,
  type MediaDocument,
  type MediaType,
  type Namespace,
  type NamespaceGroup,
  type PlatformNamespace,
  type SeasonSnapshot,
  type Segment,
} from "@media-ref/client";
import type {
  AssociationNamespaceRow,
  Database,
  Db,
  DemandStatusRow,
  DemandsTable,
  SeasonSnapshotRow,
} from "@media-ref/db";
import { sql, type Selectable, type Transaction } from "kysely";
import type { BatchMediaQueryResult, QueryMediaByKeyResult } from "./read-media.ts";

export type DemandStatus = DemandStatusRow;

export const DEFAULT_DEMAND_NAMESPACE_GROUP: NamespaceGroup = "platform";
const MAX_LIST_DEMANDS_LIMIT = 500;
const DEFAULT_LIST_DEMANDS_LIMIT = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DemandRecord {
  id: string;
  mediaId: string | null;
  externalKey: string | null;
  season: number | null;
  namespaceGroup: NamespaceGroup;
  demandCount: number;
  status: DemandStatus;
  notFoundCount: number;
  nextEligibleAt: string;
  lastExploredAt: string | null;
  leaseGeneration: number;
  leaseExpiresAt: string | null;
  lastDemandedAt: string;
  createdAt: string;
  updatedAt: string;
}

export type DemandTarget =
  | {
      kind: "media";
      mediaId: string;
      season: number | null;
      namespaceGroup: NamespaceGroup;
      delta: number;
    }
  | {
      kind: "external_key";
      externalKey: string;
      season: number | null;
      namespaceGroup: NamespaceGroup;
      delta: number;
    };

export interface RecordDemandForReadInput {
  rawKey: string;
  queryResult: QueryMediaByKeyResult;
  season?: number;
  namespaceGroup?: NamespaceGroup;
  now?: Date;
}

export interface RecordDemandsForBatchReadInput {
  results: readonly BatchMediaQueryResult[];
  season?: number;
  namespaceGroup?: NamespaceGroup;
  now?: Date;
}

export interface MergeExternalKeyDemandsInput {
  mediaId: string;
  externalKeys: readonly string[];
  seasons?: readonly number[] | readonly SeasonSnapshot[];
  mediaType?: MediaType;
  now?: Date;
}

export interface MergeExternalKeyDemandsResult {
  mergedSourceCount: number;
  demands: DemandRecord[];
}

export interface ListDemandsFilters {
  mediaId?: string;
  externalKey?: string;
  season?: number | null;
  namespaceGroup?: NamespaceGroup;
  status?: DemandStatus | readonly DemandStatus[];
  eligibleBefore?: Date;
  limit?: number;
  offset?: number;
}

type DbExecutor = Db | Transaction<Database>;

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toDemandRecord(row: Selectable<DemandsTable>): DemandRecord {
  return {
    id: row.id,
    mediaId: row.media_id,
    externalKey: row.external_key,
    season: row.season,
    namespaceGroup: row.namespace_group,
    demandCount: row.demand_count,
    status: row.status,
    notFoundCount: row.not_found_count,
    nextEligibleAt: toIsoString(row.next_eligible_at),
    lastExploredAt: row.last_explored_at ? toIsoString(row.last_explored_at) : null,
    leaseGeneration: row.lease_generation,
    leaseExpiresAt: row.lease_expires_at ? toIsoString(row.lease_expires_at) : null,
    lastDemandedAt: toIsoString(row.last_demanded_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function isConfirmedAssociation(association: Association): boolean {
  return association.status === "confirmed" && !association.unconfirmed;
}

function isSeasonCoveredInGroup(
  document: MediaDocument,
  targetSeason: number | null,
  namespaceGroup: NamespaceGroup,
): boolean {
  // The catalog group also needs the TMDB external ID: a media known only from Douban lacks it.
  if (
    namespaceGroup === "catalog" &&
    !document.externalIds.some((ext) => ext.namespace === "tmdb")
  ) {
    return false;
  }
  if (namespaceGroup === "platform") {
    const rows = document.associations.filter(isConfirmedAssociation).map((assoc) => ({
      namespace: assoc.namespace,
      seasons: assoc.segments.map((seg) => seg.season),
      listedPlatforms: assoc.listedPlatforms ?? null,
    }));
    return missingListedPlatforms(rows, targetSeason)?.length === 0;
  }
  const confirmedInGroup = document.associations.filter(
    (assoc) =>
      isConfirmedAssociation(assoc) && getNamespaceGroup(assoc.namespace) === namespaceGroup,
  );

  if (confirmedInGroup.length === 0) {
    return false;
  }

  if (targetSeason === null) {
    return true;
  }

  return confirmedInGroup.some(
    (assoc) =>
      assoc.segments.length === 0 || assoc.segments.some((seg) => seg.season === targetSeason),
  );
}

function compareDemandTargets(a: DemandTarget, b: DemandTarget): number {
  if (a.kind !== b.kind) {
    return a.kind === "media" ? -1 : 1;
  }
  const keyA = a.kind === "media" ? a.mediaId : a.externalKey;
  const keyB = b.kind === "media" ? b.mediaId : b.externalKey;
  if (keyA !== keyB) {
    return keyA < keyB ? -1 : 1;
  }
  if (a.namespaceGroup !== b.namespaceGroup) {
    return a.namespaceGroup < b.namespaceGroup ? -1 : 1;
  }
  const seasonA = a.season ?? -1;
  const seasonB = b.season ?? -1;
  return seasonA - seasonB;
}

function extractRegularTvSeasons(seasons: readonly (number | { season: number })[]): number[] {
  const unique = new Set<number>();
  for (const entry of seasons) {
    const seasonNum = typeof entry === "number" ? entry : entry.season;
    if (Number.isInteger(seasonNum) && seasonNum >= 1) {
      unique.add(seasonNum);
    }
  }
  return [...unique].sort((a, b) => a - b);
}

function parseSeasonsSnapshotJson(raw: unknown): SeasonSnapshotRow[] {
  if (Array.isArray(raw)) {
    return raw as SeasonSnapshotRow[];
  }
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as SeasonSnapshotRow[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeExternalKeyForDemand(rawKey: string): string | null {
  const trimmed = rawKey.trim();
  if (trimmed.length === 0 || UUID_PATTERN.test(trimmed) || trimmed.startsWith("media:")) {
    return null;
  }
  const parsed = parseExternalKey(trimmed);
  if (!parsed) {
    return null;
  }
  return formatExternalKey(parsed);
}

export function computeDemandTargetsForRead(
  input: Omit<RecordDemandForReadInput, "now">,
): DemandTarget[] {
  const namespaceGroup = input.namespaceGroup ?? DEFAULT_DEMAND_NAMESPACE_GROUP;
  const { rawKey, queryResult, season } = input;

  if (queryResult.kind === "invalid_key") {
    return [];
  }

  if (queryResult.kind === "not_found") {
    const formattedKey = normalizeExternalKeyForDemand(rawKey);
    if (!formattedKey) {
      return [];
    }
    return [
      {
        kind: "external_key",
        externalKey: formattedKey,
        season: season ?? null,
        namespaceGroup,
        delta: 1,
      },
    ];
  }

  const seenMediaIds = new Set<string>();
  const targets: DemandTarget[] = [];

  for (const item of queryResult.items) {
    const doc = item.document;
    if (seenMediaIds.has(doc.media.id)) {
      continue;
    }
    seenMediaIds.add(doc.media.id);

    let candidateSeasons: Array<number | null>;
    if (season !== undefined) {
      candidateSeasons = [doc.media.type === "movie" ? null : season];
    } else if (doc.media.type === "movie") {
      candidateSeasons = [null];
    } else {
      const regularSeasons = extractRegularTvSeasons(doc.media.snapshot.seasons);
      candidateSeasons = regularSeasons.length > 0 ? regularSeasons : [null];
    }

    for (const targetSeason of candidateSeasons) {
      if (!isSeasonCoveredInGroup(doc, targetSeason, namespaceGroup)) {
        targets.push({
          kind: "media",
          mediaId: doc.media.id,
          season: targetSeason,
          namespaceGroup,
          delta: 1,
        });
      }
    }
  }

  targets.sort(compareDemandTargets);
  return targets;
}

export function computeDemandTargetsForBatchRead(
  input: Omit<RecordDemandsForBatchReadInput, "now">,
): DemandTarget[] {
  const aggregated = new Map<string, DemandTarget>();

  for (const entry of input.results) {
    let queryResult: QueryMediaByKeyResult;
    if (entry.ok) {
      queryResult = { kind: "ok", key: entry.key, items: entry.items };
    } else if (entry.error === "NOT_FOUND") {
      queryResult = { kind: "not_found", key: entry.key };
    } else {
      continue;
    }

    const entryTargets = computeDemandTargetsForRead({
      rawKey: entry.key,
      queryResult,
      season: input.season,
      namespaceGroup: input.namespaceGroup,
    });

    for (const target of entryTargets) {
      const mapKey =
        target.kind === "media"
          ? `m\0${target.mediaId}\0${target.season ?? "null"}\0${target.namespaceGroup}`
          : `e\0${target.externalKey}\0${target.season ?? "null"}\0${target.namespaceGroup}`;
      const existing = aggregated.get(mapKey);
      if (existing) {
        existing.delta += target.delta;
      } else {
        aggregated.set(mapKey, { ...target });
      }
    }
  }

  return [...aggregated.values()].sort(compareDemandTargets);
}

interface MediaDemandUpsertPayload {
  mediaId: string;
  season: number | null;
  namespaceGroup: NamespaceGroup;
  delta: number;
  status: DemandStatus;
  notFoundCount: number;
  nextEligibleAt: Date;
  lastExploredAt: Date | null;
  lastDemandedAt: Date;
}

async function upsertMediaDemandRow(
  executor: DbExecutor,
  payload: MediaDemandUpsertPayload,
  now: Date,
): Promise<DemandRecord> {
  const result = await sql<Selectable<DemandsTable>>`
    insert into demands (
      media_id,
      external_key,
      season,
      namespace_group,
      demand_count,
      status,
      not_found_count,
      next_eligible_at,
      last_explored_at,
      last_demanded_at,
      created_at,
      updated_at
    )
    values (
      ${payload.mediaId}::uuid,
      null,
      ${payload.season}::integer,
      ${payload.namespaceGroup}::text,
      ${payload.delta}::integer,
      ${payload.status}::text,
      ${payload.notFoundCount}::integer,
      ${payload.nextEligibleAt}::timestamptz,
      ${payload.lastExploredAt}::timestamptz,
      ${payload.lastDemandedAt}::timestamptz,
      ${now}::timestamptz,
      ${now}::timestamptz
    )
    on conflict (media_id, coalesce(season, -1), namespace_group)
    where media_id is not null
    do update set
      demand_count = demands.demand_count + excluded.demand_count,
      status = case
        when demands.status = 'fulfilled' then 'open'
        else demands.status
      end,
      next_eligible_at = case
        when demands.status = 'fulfilled' then excluded.next_eligible_at
        else demands.next_eligible_at
      end,
      not_found_count = greatest(demands.not_found_count, excluded.not_found_count),
      last_explored_at = coalesce(
        greatest(demands.last_explored_at, excluded.last_explored_at),
        demands.last_explored_at,
        excluded.last_explored_at
      ),
      last_demanded_at = greatest(demands.last_demanded_at, excluded.last_demanded_at),
      updated_at = excluded.updated_at
    returning *
  `.execute(executor);

  return toDemandRecord(result.rows[0]!);
}

async function upsertExternalKeyDemandTarget(
  executor: DbExecutor,
  target: Extract<DemandTarget, { kind: "external_key" }>,
  now: Date,
): Promise<DemandRecord> {
  const result = await sql<Selectable<DemandsTable>>`
    insert into demands (
      media_id,
      external_key,
      season,
      namespace_group,
      demand_count,
      status,
      not_found_count,
      next_eligible_at,
      last_explored_at,
      last_demanded_at,
      created_at,
      updated_at
    )
    values (
      null,
      ${target.externalKey}::text,
      ${target.season}::integer,
      ${target.namespaceGroup}::text,
      ${target.delta}::integer,
      'open',
      0,
      ${now}::timestamptz,
      null,
      ${now}::timestamptz,
      ${now}::timestamptz,
      ${now}::timestamptz
    )
    on conflict (external_key, coalesce(season, -1), namespace_group)
    where media_id is null
    do update set
      demand_count = demands.demand_count + excluded.demand_count,
      status = case
        when demands.status = 'fulfilled' then 'open'
        else demands.status
      end,
      next_eligible_at = case
        when demands.status = 'fulfilled' then excluded.next_eligible_at
        else demands.next_eligible_at
      end,
      last_demanded_at = greatest(demands.last_demanded_at, excluded.last_demanded_at),
      updated_at = excluded.updated_at
    returning *
  `.execute(executor);

  return toDemandRecord(result.rows[0]!);
}

async function applyDemandTargets(
  dbWrite: DbExecutor,
  targets: readonly DemandTarget[],
  now: Date,
): Promise<DemandRecord[]> {
  if (targets.length === 0) {
    return [];
  }

  const recorded: DemandRecord[] = [];
  for (const target of targets) {
    if (target.kind === "media") {
      recorded.push(
        await upsertMediaDemandRow(
          dbWrite,
          {
            mediaId: target.mediaId,
            season: target.season,
            namespaceGroup: target.namespaceGroup,
            delta: target.delta,
            status: "open",
            notFoundCount: 0,
            nextEligibleAt: now,
            lastExploredAt: null,
            lastDemandedAt: now,
          },
          now,
        ),
      );
    } else {
      recorded.push(await upsertExternalKeyDemandTarget(dbWrite, target, now));
    }
  }
  return recorded;
}

export async function recordDemandForRead(
  dbWrite: DbExecutor,
  input: RecordDemandForReadInput,
): Promise<DemandRecord[]> {
  const targets = computeDemandTargetsForRead(input);
  return applyDemandTargets(dbWrite, targets, input.now ?? new Date());
}

export async function recordDemandsForBatchRead(
  dbWrite: DbExecutor,
  input: RecordDemandsForBatchReadInput,
): Promise<DemandRecord[]> {
  const targets = computeDemandTargetsForBatchRead(input);
  return applyDemandTargets(dbWrite, targets, input.now ?? new Date());
}

const STATUS_MERGE_PRIORITY: Record<DemandStatus, number> = {
  open: 0,
  not_found: 1,
  leased: 2,
  awaiting_review: 3,
  fulfilled: 4,
  invalid_key: 5,
};

export const DEFAULT_NOT_FOUND_BACKOFF_SECONDS = [86_400, 259_200, 604_800, 2_592_000] as const;

export function computeNotFoundBackoffSeconds(
  attemptNumber: number,
  schedule: readonly number[] = DEFAULT_NOT_FOUND_BACKOFF_SECONDS,
): number {
  const effective = schedule.length > 0 ? schedule : DEFAULT_NOT_FOUND_BACKOFF_SECONDS;
  const normalizedAttempt = Number.isFinite(attemptNumber) ? Math.floor(attemptNumber) : 1;
  const index = Math.min(Math.max(normalizedAttempt - 1, 0), effective.length - 1);
  return effective[index]!;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

async function runInTransaction<T>(
  db: DbExecutor,
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  if (db.isTransaction) {
    return fn(db as Transaction<Database>);
  }
  return (db as Db).transaction().execute(fn);
}

export async function mergeExternalKeyDemandsIntoMedia(
  dbWrite: DbExecutor,
  input: MergeExternalKeyDemandsInput,
): Promise<MergeExternalKeyDemandsResult> {
  const normalizedKeys = [
    ...new Set(
      input.externalKeys
        .map((raw) => normalizeExternalKeyForDemand(raw))
        .filter((key): key is string => key !== null),
    ),
  ];

  if (normalizedKeys.length === 0) {
    return { mergedSourceCount: 0, demands: [] };
  }

  const now = input.now ?? new Date();

  return runInTransaction(dbWrite, async (trx) => {
    // Deleted only after their change requests are re-linked: `change_requests.demand_id` is
    // ON DELETE SET NULL, and a request in review with no demand lets the sweep reopen it.
    const deletedRows = await trx
      .selectFrom("demands")
      .selectAll()
      .where("media_id", "is", null)
      .where("external_key", "in", normalizedKeys)
      .forUpdate()
      .execute();

    if (deletedRows.length === 0) {
      return { mergedSourceCount: 0, demands: [] };
    }

    let mediaType = input.mediaType;
    let regularTvSeasons: number[] | undefined =
      input.seasons !== undefined ? extractRegularTvSeasons(input.seasons) : undefined;

    if (mediaType === undefined || (mediaType === "tv" && regularTvSeasons === undefined)) {
      const mediaRow = await trx
        .selectFrom("media")
        .select(["type", "seasons"])
        .where("id", "=", input.mediaId)
        .executeTakeFirst();

      if (mediaRow) {
        mediaType ??= mediaRow.type;
        if (regularTvSeasons === undefined) {
          regularTvSeasons = extractRegularTvSeasons(parseSeasonsSnapshotJson(mediaRow.seasons));
        }
      }
    }

    const tvSeasons = regularTvSeasons ?? [];
    const aggregated = new Map<string, MediaDemandUpsertPayload>();
    // Where each source demand's change requests move: its first target demand.
    const relinkKeyBySourceId = new Map<string, string>();

    for (const row of deletedRows) {
      let targetSeasons: Array<number | null>;
      if (mediaType === "movie") {
        targetSeasons = [null];
      } else if (row.season !== null) {
        targetSeasons = [row.season];
      } else if (mediaType === "tv" && tvSeasons.length > 0) {
        targetSeasons = tvSeasons;
      } else {
        targetSeasons = [null];
      }

      const rowLastDemandedAt = toDate(row.last_demanded_at);
      const reopen = row.status === "leased" || row.status === "invalid_key";
      const status = reopen ? "open" : row.status;
      const rowNextEligibleAt = reopen ? now : toDate(row.next_eligible_at);
      const rowLastExploredAt = row.last_explored_at ? toDate(row.last_explored_at) : null;

      for (const targetSeason of targetSeasons) {
        const key = `${row.namespace_group}\0${targetSeason ?? "null"}`;
        if (!relinkKeyBySourceId.has(row.id)) relinkKeyBySourceId.set(row.id, key);
        const existing = aggregated.get(key);
        if (!existing) {
          aggregated.set(key, {
            mediaId: input.mediaId,
            season: targetSeason,
            namespaceGroup: row.namespace_group,
            delta: row.demand_count,
            status,
            notFoundCount: row.not_found_count,
            nextEligibleAt: rowNextEligibleAt,
            lastExploredAt: rowLastExploredAt,
            lastDemandedAt: rowLastDemandedAt,
          });
        } else {
          existing.delta += row.demand_count;
          if (STATUS_MERGE_PRIORITY[status] < STATUS_MERGE_PRIORITY[existing.status]) {
            existing.status = status;
          }
          existing.notFoundCount = Math.max(existing.notFoundCount, row.not_found_count);
          if (rowLastDemandedAt.getTime() > existing.lastDemandedAt.getTime()) {
            existing.lastDemandedAt = rowLastDemandedAt;
          }
          if (
            rowLastExploredAt &&
            (!existing.lastExploredAt ||
              rowLastExploredAt.getTime() > existing.lastExploredAt.getTime())
          ) {
            existing.lastExploredAt = rowLastExploredAt;
          }
          if (existing.status === "open") {
            if (rowNextEligibleAt.getTime() < existing.nextEligibleAt.getTime()) {
              existing.nextEligibleAt = rowNextEligibleAt;
            }
          } else if (rowNextEligibleAt.getTime() > existing.nextEligibleAt.getTime()) {
            existing.nextEligibleAt = rowNextEligibleAt;
          }
        }
      }
    }

    const sortedPayloads = [...aggregated.values()].sort((a, b) => {
      if (a.namespaceGroup !== b.namespaceGroup) {
        return a.namespaceGroup < b.namespaceGroup ? -1 : 1;
      }
      return (a.season ?? -1) - (b.season ?? -1);
    });

    const demands: DemandRecord[] = [];
    const demandIdByKey = new Map<string, string>();
    for (const payload of sortedPayloads) {
      const demand = await upsertMediaDemandRow(trx, payload, now);
      demands.push(demand);
      demandIdByKey.set(`${payload.namespaceGroup}\0${payload.season ?? "null"}`, demand.id);
    }

    for (const row of deletedRows) {
      await trx
        .updateTable("change_requests")
        .set({ demand_id: demandIdByKey.get(relinkKeyBySourceId.get(row.id)!)!, updated_at: now })
        .where("demand_id", "=", row.id)
        .execute();
    }
    await trx
      .deleteFrom("demands")
      .where(
        "id",
        "in",
        deletedRows.map((row) => row.id),
      )
      .execute();

    return {
      mergedSourceCount: deletedRows.length,
      demands,
    };
  });
}

export async function listDemands(
  db: DbExecutor,
  filters: ListDemandsFilters = {},
): Promise<DemandRecord[]> {
  const limit = Math.min(
    Math.max(Math.floor(filters.limit ?? DEFAULT_LIST_DEMANDS_LIMIT), 1),
    MAX_LIST_DEMANDS_LIMIT,
  );
  const offset = Math.max(Math.floor(filters.offset ?? 0), 0);

  let query = db.selectFrom("demands").selectAll();

  if (filters.mediaId !== undefined) {
    query = query.where("media_id", "=", filters.mediaId);
  }
  if (filters.externalKey !== undefined) {
    query = query.where("external_key", "=", filters.externalKey);
  }
  if (filters.season === null) {
    query = query.where("season", "is", null);
  } else if (filters.season !== undefined) {
    query = query.where("season", "=", filters.season);
  }
  if (filters.namespaceGroup !== undefined) {
    query = query.where("namespace_group", "=", filters.namespaceGroup);
  }
  if (filters.status !== undefined) {
    if (Array.isArray(filters.status)) {
      if (filters.status.length === 0) {
        return [];
      }
      query = query.where("status", "in", [...filters.status]);
    } else {
      query = query.where("status", "=", filters.status as DemandStatus);
    }
  }
  if (filters.eligibleBefore !== undefined) {
    query = query.where("next_eligible_at", "<=", filters.eligibleBefore);
  }

  const rows = await query
    .orderBy("demand_count", "desc")
    .orderBy("last_demanded_at", "desc")
    .orderBy("season", "asc")
    .orderBy("created_at", "asc")
    .orderBy("id", "asc")
    .limit(limit)
    .offset(offset)
    .execute();

  return rows.map(toDemandRecord);
}

const ASSOCIATION_CATALOG_NAMESPACES: readonly AssociationNamespaceRow[] = ["douban", "bangumi"];

export interface FulfillCoveredDemandsInput {
  mediaId: string;
  namespace: Namespace;
  segments: readonly Pick<Segment, "season">[];
  now?: Date;
}

const PENDING_REQUEST_STATUSES = ["pending_evidence", "needs_review"] as const;

export async function hasCorrectionForDemandRoundInTx(
  executor: DbExecutor,
  demand: Selectable<DemandsTable>,
): Promise<boolean> {
  const corrected = await executor
    .selectFrom("change_requests")
    .select("id")
    .where("demand_id", "=", demand.id)
    .where("status", "=", "rejected")
    .where(
      sql<boolean>`evidence @> ${JSON.stringify({ correctedDemandGeneration: demand.lease_generation })}::jsonb`,
    )
    .executeTakeFirst();
  return corrected !== undefined;
}

/** The caller holds the demand row lock while deciding which review outcome still applies. */
export async function settleDemandAfterSubmissionInTx(
  executor: DbExecutor,
  demand: Selectable<DemandsTable>,
  now: Date,
  corrected?: boolean,
): Promise<boolean> {
  const covered =
    demand.media_id !== null &&
    (await isMediaDemandCoveredInTx(executor, {
      mediaId: demand.media_id,
      season: demand.season,
      namespaceGroup: demand.namespace_group,
    }));
  const pending =
    !covered &&
    (await executor
      .selectFrom("change_requests")
      .select("id")
      .where("demand_id", "=", demand.id)
      .where("status", "in", PENDING_REQUEST_STATUSES)
      .executeTakeFirst());
  if (pending && demand.status === "awaiting_review") {
    return false;
  }
  const status = covered ? "fulfilled" : pending ? "awaiting_review" : "open";
  const retryNow =
    status === "open" && (corrected ?? (await hasCorrectionForDemandRoundInTx(executor, demand)));
  const notFoundCount = demand.not_found_count + (retryNow ? 0 : 1);
  await executor
    .updateTable("demands")
    .set({
      status,
      ...(status === "open" && {
        not_found_count: notFoundCount,
        next_eligible_at: retryNow
          ? now
          : new Date(now.getTime() + computeNotFoundBackoffSeconds(notFoundCount) * 1000),
      }),
      ...(demand.status === "leased" && { last_explored_at: now }),
      lease_expires_at: null,
      updated_at: now,
    })
    .where("id", "=", demand.id)
    .execute();
  return status === "open";
}

export async function reopenDemandAfterRejectionInTx(
  executor: DbExecutor,
  input: { demandId: string; now: Date },
): Promise<boolean> {
  const demand = await executor
    .selectFrom("demands")
    .selectAll()
    .where("id", "=", input.demandId)
    .forUpdate()
    .executeTakeFirst();
  return demand?.status === "awaiting_review"
    ? settleDemandAfterSubmissionInTx(executor, demand, input.now)
    : false;
}

export async function settleOrphanedReviewDemandsInTx(
  trx: Transaction<Database>,
  now: Date,
): Promise<void> {
  const orphans = await trx
    .selectFrom("demands")
    .selectAll()
    .where("status", "=", "awaiting_review")
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("change_requests")
            .select("id")
            .whereRef("change_requests.demand_id", "=", "demands.id")
            .where("status", "in", PENDING_REQUEST_STATUSES),
        ),
      ),
    )
    .orderBy("id")
    .forUpdate()
    .skipLocked()
    .execute();
  for (const demand of orphans) {
    await settleDemandAfterSubmissionInTx(trx, demand, now);
  }
}

/**
 * After the review agent takes back an approval (ADR 0003 amendment 2), every demand the approval
 * could have fulfilled opens again unless another confirmed association still covers it. That is
 * the same set `fulfillCoveredDemandsForAssociationInTx` fulfils: all of the media's demands in the
 * group for a whole-media association (`seasons` empty), else the whole-media demand and the
 * covered seasons'. The revocation counts as a not-found round, like a rejection: the demand backs
 * off before exploration looks again.
 */
export async function reopenDemandsAfterRevokeInTx(
  executor: DbExecutor,
  input: {
    mediaId: string;
    /** Seasons of the revoked association's segments; empty for a whole-media association. */
    seasons: readonly number[];
    /** A season left alone (a correction makes it explorable now instead). */
    exceptSeason?: number | null;
    namespaceGroup: NamespaceGroup;
    now: Date;
  },
): Promise<void> {
  const seasons = [...new Set(input.seasons)];
  let query = executor
    .selectFrom("demands")
    .select(["id", "season", "not_found_count"])
    .where("media_id", "=", input.mediaId)
    .where("namespace_group", "=", input.namespaceGroup)
    .where("status", "in", ["open", "not_found", "fulfilled"]);
  if (seasons.length > 0) {
    query = query.where((eb) => eb.or([eb("season", "is", null), eb("season", "in", seasons)]));
  }
  const rows = await query.forUpdate().execute();
  for (const row of rows) {
    if (input.exceptSeason != null && row.season === input.exceptSeason) {
      continue;
    }
    const target = {
      mediaId: input.mediaId,
      season: row.season,
      namespaceGroup: input.namespaceGroup,
    };
    if (await isCoveredByAssociationsInTx(executor, target)) {
      continue;
    }
    const notFoundCount = row.not_found_count + 1;
    await executor
      .updateTable("demands")
      .set({
        status: "open",
        not_found_count: notFoundCount,
        next_eligible_at: new Date(
          input.now.getTime() + computeNotFoundBackoffSeconds(notFoundCount) * 1000,
        ),
        updated_at: input.now,
      })
      .where("id", "=", row.id)
      .execute();
  }
}

/**
 * Makes `(media or external key, season, namespace group)` explorable now, for a review agent
 * correction (ADR 0003 §4): creates the demand, or reopens it without a not-found round. A demand
 * being explored or awaiting review is left alone.
 */
export async function ensureDemandExplorableNowInTx(
  executor: DbExecutor,
  input: {
    mediaId: string | null;
    externalKey: string;
    season: number;
    namespaceGroup: NamespaceGroup;
    now: Date;
  },
): Promise<void> {
  const { mediaId, season, namespaceGroup, now } = input;
  const demand = mediaId
    ? await upsertMediaDemandRow(
        executor,
        {
          mediaId,
          season,
          namespaceGroup,
          delta: 1,
          status: "open",
          notFoundCount: 0,
          nextEligibleAt: now,
          lastExploredAt: null,
          lastDemandedAt: now,
        },
        now,
      )
    : await upsertExternalKeyDemandTarget(
        executor,
        { kind: "external_key", externalKey: input.externalKey, season, namespaceGroup, delta: 1 },
        now,
      );
  const covered =
    mediaId !== null &&
    (await isMediaDemandCoveredInTx(executor, { mediaId, season, namespaceGroup }));
  await executor
    .updateTable("demands")
    .set({ status: covered ? "fulfilled" : "open", next_eligible_at: now, updated_at: now })
    .where("id", "=", demand.id)
    .where("status", "in", ["open", "not_found", "fulfilled"])
    .execute();
}

/**
 * Marks open, not_found or awaiting_review demands for `(mediaId, season, namespaceGroup)` as `fulfilled`
 * once a confirmed association covers them. Whole-media associations (`segments: []`)
 * fulfill all seasons in that namespace group.
 */
export async function fulfillCoveredDemandsForAssociationInTx(
  executor: DbExecutor,
  input: FulfillCoveredDemandsInput,
): Promise<number> {
  const namespaceGroup = getNamespaceGroup(input.namespace);
  const now = input.now ?? new Date();
  if (namespaceGroup === "catalog" && !(await hasTmdbExternalId(executor, input.mediaId))) {
    // The association landed but the TMDB external ID is still missing: a demand waiting on this
    // review goes back to open, so the next exploration retries the TMDB lookup instead of
    // leaving it parked in awaiting_review with nothing left to resolve it.
    let reopen = executor
      .updateTable("demands")
      .set({ status: "open", next_eligible_at: now, lease_expires_at: null, updated_at: now })
      .where("media_id", "=", input.mediaId)
      .where("namespace_group", "=", "catalog")
      .where("status", "=", "awaiting_review");
    if (input.segments.length > 0) {
      const coveredSeasons = [...new Set(input.segments.map((seg) => seg.season))];
      reopen = reopen.where((eb) =>
        eb.or([eb("season", "is", null), eb("season", "in", coveredSeasons)]),
      );
    }
    await reopen.execute();
    return 0;
  }

  let query = executor
    .selectFrom("demands")
    .select(["id", "season"])
    .where("media_id", "=", input.mediaId)
    .where("namespace_group", "=", namespaceGroup)
    .where("status", "in", ["open", "not_found", "awaiting_review"]);

  if (input.segments.length > 0) {
    const coveredSeasons = [...new Set(input.segments.map((seg) => seg.season))];
    query = query.where((eb) =>
      eb.or([eb("season", "is", null), eb("season", "in", coveredSeasons)]),
    );
  }

  const ids: string[] = [];
  for (const demand of await query.execute()) {
    // One platform is not enough while the season's Douban subject lists others still missing;
    // an uncovered demand keeps its state, so a sibling's rejection still settles it.
    if (
      namespaceGroup !== "platform" ||
      (await isCoveredByAssociationsInTx(executor, {
        mediaId: input.mediaId,
        season: demand.season,
        namespaceGroup,
      }))
    ) {
      ids.push(demand.id);
    }
  }
  if (ids.length === 0) {
    return 0;
  }
  await executor
    .updateTable("demands")
    .set({ status: "fulfilled", lease_expires_at: null, updated_at: now })
    .where("id", "in", ids)
    .execute();
  return ids.length;
}

/**
 * Gives each media without the TMDB external ID (one created from Douban or Bangumi) an open
 * catalog demand, so exploration looks the ID up even when no caller asked for the catalog group.
 * One demand per media is enough: the TMDB ID is media-wide. Returns how many were added.
 */
export async function enqueueTmdbLookupDemands(
  db: Db,
  input: { now: Date; limit?: number },
): Promise<number> {
  const rows = await db
    .selectFrom("media")
    .select(["id", "type", "seasons"])
    .where("merged_into_media_id", "is", null)
    // A TMDB-baseline media gets its TMDB ID when it is created.
    .where((eb) => eb.or([eb("baseline", "is", null), eb("baseline", "!=", "tmdb")]))
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("associations")
            .select("associations.id")
            .whereRef("associations.media_id", "=", "media.id")
            .where("associations.namespace", "=", "tmdb")
            .where("associations.is_external_id", "=", true),
        ),
      ),
    )
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("demands")
            .select("demands.id")
            .whereRef("demands.media_id", "=", "media.id")
            .where("demands.namespace_group", "=", "catalog"),
        ),
      ),
    )
    .orderBy("created_at")
    .limit(input.limit ?? 20)
    .execute();
  for (const row of rows) {
    await upsertMediaDemandRow(
      db,
      {
        mediaId: row.id,
        season: row.type === "movie" ? null : (extractRegularTvSeasons(row.seasons)[0] ?? null),
        namespaceGroup: "catalog",
        delta: 1,
        status: "open",
        notFoundCount: 0,
        nextEligibleAt: input.now,
        lastExploredAt: null,
        lastDemandedAt: input.now,
      },
      input.now,
    );
  }
  return rows.length;
}

async function hasTmdbExternalId(executor: DbExecutor, mediaId: string): Promise<boolean> {
  const row = await executor
    .selectFrom("associations")
    .select("id")
    .where("media_id", "=", mediaId)
    .where("namespace", "=", "tmdb")
    .where("is_external_id", "=", true)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Fulfills the media's open, not_found or awaiting_review catalog demands that are now covered,
 * e.g. after the agent wrote the missing TMDB external ID.
 */
export async function fulfillCoveredCatalogDemandsInTx(
  executor: DbExecutor,
  input: { mediaId: string; now: Date },
): Promise<number> {
  const demands = await executor
    .selectFrom("demands")
    .select(["id", "season"])
    .where("media_id", "=", input.mediaId)
    .where("namespace_group", "=", "catalog")
    .where("status", "in", ["open", "not_found", "awaiting_review"])
    .execute();
  let fulfilled = 0;
  for (const demand of demands) {
    if (
      await isMediaDemandCoveredInTx(executor, {
        mediaId: input.mediaId,
        season: demand.season,
        namespaceGroup: "catalog",
      })
    ) {
      await executor
        .updateTable("demands")
        .set({ status: "fulfilled", lease_expires_at: null, updated_at: input.now })
        .where("id", "=", demand.id)
        .execute();
      fulfilled += 1;
    }
  }
  return fulfilled;
}

export interface CheckMediaDemandCoveredInput {
  mediaId: string;
  season: number | null;
  namespaceGroup: NamespaceGroup;
}

/**
 * Checks whether `(mediaId, season, namespaceGroup)` is already covered by at least one
 * confirmed association (matching `isSeasonCoveredInGroup` semantics).
 */
export async function isMediaDemandCoveredInTx(
  executor: DbExecutor,
  input: CheckMediaDemandCoveredInput,
): Promise<boolean> {
  if (input.namespaceGroup === "catalog" && !(await hasTmdbExternalId(executor, input.mediaId))) {
    return false;
  }
  return isCoveredByAssociationsInTx(executor, input);
}

/**
 * The association half of demand coverage: a confirmed association in the group covers the
 * season. On platforms, so must every platform the season's confirmed Douban subject lists (#130).
 */
export async function isCoveredByAssociationsInTx(
  executor: DbExecutor,
  input: CheckMediaDemandCoveredInput,
): Promise<boolean> {
  if (input.namespaceGroup === "platform") {
    return (await missingListedPlatformsInTx(executor, input))?.length === 0;
  }
  const rows = await loadConfirmedCoverageRows(
    executor,
    input.mediaId,
    ASSOCIATION_CATALOG_NAMESPACES,
  );
  return rows.some((row) => coversSeason(row, input.season));
}

/** Checks whether a single namespace already has a confirmed association covering `season`. */
export async function isNamespaceCoveredInTx(
  executor: DbExecutor,
  input: { mediaId: string; namespace: AssociationNamespaceRow; season: number | null },
): Promise<boolean> {
  const rows = await loadConfirmedCoverageRows(executor, input.mediaId, [input.namespace]);
  return rows.some((row) => coversSeason(row, input.season));
}

/** `missingListedPlatforms` over the media's confirmed platform and Douban associations. */
export async function missingListedPlatformsInTx(
  executor: DbExecutor,
  input: { mediaId: string; season: number | null },
): Promise<PlatformNamespace[] | null> {
  const rows = await loadConfirmedCoverageRows(executor, input.mediaId, [
    ...PLATFORM_NAMESPACES,
    "douban",
  ]);
  return missingListedPlatforms(rows, input.season);
}

interface CoverageRow {
  namespace: string;
  /** Seasons of the association's segments; none = the whole media. */
  seasons: readonly number[];
  listedPlatforms: readonly string[] | null;
}

const coversSeason = (row: CoverageRow, season: number | null) =>
  season === null || row.seasons.length === 0 || row.seasons.includes(season);

/**
 * Platforms still wanted for a season that some confirmed platform already covers: those its
 * confirmed Douban subject lists that nothing covers yet. Null while no platform covers the season,
 * i.e. every platform is still wanted. A season is covered when this is empty.
 */
export function missingListedPlatforms(
  rows: readonly CoverageRow[],
  season: number | null,
): PlatformNamespace[] | null {
  const covering = rows.filter((row) => coversSeason(row, season));
  if (!covering.some((row) => isPlatformNamespace(row.namespace))) {
    return null;
  }
  const covered = new Set(covering.map((row) => row.namespace));
  const listed = covering.flatMap((row) =>
    row.namespace === "douban" ? (row.listedPlatforms ?? []) : [],
  );
  return [...new Set(listed)].filter(
    (ns): ns is PlatformNamespace => isPlatformNamespace(ns) && !covered.has(ns),
  );
}

async function loadConfirmedCoverageRows(
  executor: DbExecutor,
  mediaId: string,
  namespaces: readonly AssociationNamespaceRow[],
): Promise<CoverageRow[]> {
  const rows = await executor
    .selectFrom("associations")
    .select(["id", "namespace", "listed_platforms"])
    .where("is_external_id", "=", false)
    .where("media_id", "=", mediaId)
    .where("status", "=", "confirmed")
    .where("namespace", "in", [...namespaces])
    .execute();
  if (rows.length === 0) {
    return [];
  }
  const segments = await executor
    .selectFrom("segments")
    .select(["association_id", "season"])
    .where(
      "association_id",
      "in",
      rows.map((row) => row.id),
    )
    .execute();
  return rows.map((row) => ({
    namespace: row.namespace,
    seasons: segments.filter((seg) => seg.association_id === row.id).map((seg) => seg.season),
    listedPlatforms: row.listed_platforms,
  }));
}
