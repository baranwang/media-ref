import {
  formatExternalKey,
  getNamespaceGroup,
  parseExternalKey,
  type Association,
  type MediaDocument,
  type MediaType,
  type NamespaceGroup,
  type SeasonSnapshot,
} from "@media-ref/client";
import type { Database, Db, DemandStatusRow, DemandsTable, SeasonSnapshotRow } from "@media-ref/db";
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
  fulfilled: 3,
  invalid_key: 4,
};

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
    const deletedRows = await trx
      .deleteFrom("demands")
      .where("media_id", "is", null)
      .where("external_key", "in", normalizedKeys)
      .returningAll()
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
      const rowNextEligibleAt = toDate(row.next_eligible_at);
      const rowLastExploredAt = row.last_explored_at ? toDate(row.last_explored_at) : null;

      for (const targetSeason of targetSeasons) {
        const key = `${row.namespace_group}\0${targetSeason ?? "null"}`;
        const existing = aggregated.get(key);
        if (!existing) {
          aggregated.set(key, {
            mediaId: input.mediaId,
            season: targetSeason,
            namespaceGroup: row.namespace_group,
            delta: row.demand_count,
            status: row.status,
            notFoundCount: row.not_found_count,
            nextEligibleAt: rowNextEligibleAt,
            lastExploredAt: rowLastExploredAt,
            lastDemandedAt: rowLastDemandedAt,
          });
        } else {
          existing.delta += row.demand_count;
          if (STATUS_MERGE_PRIORITY[row.status] < STATUS_MERGE_PRIORITY[existing.status]) {
            existing.status = row.status;
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
    for (const payload of sortedPayloads) {
      demands.push(await upsertMediaDemandRow(trx, payload, now));
    }

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
