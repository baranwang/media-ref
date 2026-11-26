import type { ColumnType, Generated, GeneratedAlways } from "kysely";

export interface SchemaMetaTable {
  key: string;
  value: string;
  updated_at: Generated<Date>;
}

export interface UserTable {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
  role: Generated<string>;
  reputation: Generated<number>;
}

export interface SessionTable {
  id: string;
  expiresAt: Date;
  token: string;
  createdAt: Generated<Date>;
  updatedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  userId: string;
}

export interface AccountTable {
  id: string;
  accountId: string;
  providerId: string;
  userId: string;
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  scope: string | null;
  password: string | null;
  createdAt: Generated<Date>;
  updatedAt: Date;
}

export interface VerificationTable {
  id: string;
  identifier: string;
  value: string;
  expiresAt: Date;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

export type BackgroundJobStatus = "pending" | "leased" | "completed" | "failed";

export type JsonObject = Record<string, unknown>;

export interface BackgroundJobsTable {
  id: Generated<string>;
  job_type: string;
  dedupe_key: string | null;
  status: BackgroundJobStatus;
  priority: Generated<number>;
  payload: ColumnType<JsonObject, JsonObject | string | undefined, JsonObject | string>;
  result: ColumnType<
    JsonObject | null,
    JsonObject | string | null | undefined,
    JsonObject | string | null
  >;
  error_message: string | null;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  run_after: Generated<Date>;
  lease_generation: Generated<number>;
  lease_expires_at: Date | null;
  leased_at: Date | null;
  completed_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ApiKeyTable {
  id: string;
  configId: string;
  name: string | null;
  start: string | null;
  referenceId: string;
  prefix: string | null;
  key: string;
  refillInterval: number | null;
  refillAmount: number | null;
  lastRefillAt: Date | null;
  enabled: boolean | null;
  rateLimitEnabled: boolean | null;
  rateLimitTimeWindow: number | null;
  rateLimitMax: number | null;
  requestCount: number | null;
  remaining: number | null;
  lastRequest: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  permissions: string | null;
  metadata: string | null;
}

export type MediaTypeRow = "movie" | "tv";
export type BaselineSourceRow = "tmdb" | "tvdb" | "imdb" | "bangumi" | "douban";
export type ExternalIdNamespaceRow = "tmdb" | "imdb" | "tvdb" | "trakt";
export type ExternalIdSourceRow = "sync" | "reviewer" | "submission" | "agent";
export type PlatformNamespaceRow = "tencent" | "iqiyi" | "youku" | "bilibili" | "mgtv";
export type PlatformCheckStatusRow = "not_found";
export type AssociationNamespaceRow =
  | PlatformNamespaceRow
  | ExternalIdNamespaceRow
  | "douban"
  | "bangumi";
export type NamespaceVerificationModeRow = "sync" | "evidence";
export type AssociationStatusRow = "confirmed" | "seed_unconfirmed" | "delisted";
export type ChangeRequestStatusRow = "pending_evidence" | "approved" | "needs_review" | "rejected";
export type SubmitterTypeRow = "human" | "agent";
export type DemandNamespaceGroupRow = "platform" | "catalog";
export type DemandStatusRow =
  | "open"
  | "leased"
  | "awaiting_review"
  | "fulfilled"
  | "not_found"
  | "invalid_key";

export interface SeasonSnapshotRow {
  season: number;
  episodeCount: number;
  airYear: number | null;
}

export interface StoredSegmentJson {
  season: number;
  episodeStart: number;
  episodeEnd: number | null;
  targetEpisodeStart: number;
  baseline: BaselineSourceRow;
  nonLinear: boolean;
  needsReview: boolean;
}

export interface MediaTable {
  id: Generated<string>;
  type: MediaTypeRow;
  baseline: BaselineSourceRow | null;
  title: string;
  original_title: string | null;
  year: number | null;
  seasons: ColumnType<
    SeasonSnapshotRow[],
    SeasonSnapshotRow[] | string | undefined,
    SeasonSnapshotRow[] | string
  >;
  merged_into_media_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** Namespace capability registry (ADR 0001); mirrors NAMESPACE_CAPABILITIES in @media-ref/client. */
export interface NamespacesTable {
  namespace: AssociationNamespaceRow;
  namespace_group: DemandNamespaceGroupRow;
  supports_variants: boolean;
  allow_hierarchical_scopes: boolean;
  verification_mode: NamespaceVerificationModeRow;
}

export interface VariantsTable {
  id: Generated<string>;
  media_id: string;
  platform: PlatformNamespaceRow;
  description: string;
  is_default: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AssociationsTable {
  id: Generated<string>;
  media_id: string;
  namespace: AssociationNamespaceRow;
  native_id: string;
  variant_id: string | null;
  status: AssociationStatusRow;
  needs_review: Generated<boolean>;
  locked: Generated<boolean>;
  current_revision_id: string | null;
  /** Display snapshot of the collection/entry from evidence check or upstream sync. */
  title: string | null;
  episode_count: number | null;
  /** The whole-media association on an authority catalog: the media's External ID. */
  is_external_id: Generated<boolean>;
  /** Only set on External IDs. */
  source: ExternalIdSourceRow | null;
  has_variant: GeneratedAlways<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AssociationRevisionsTable {
  id: Generated<string>;
  association_id: string;
  revision_number: number;
  change_request_id: string | null;
  variant_id: string | null;
  status: AssociationStatusRow;
  segments: ColumnType<
    StoredSegmentJson[],
    StoredSegmentJson[] | string | undefined,
    StoredSegmentJson[] | string
  >;
  actor_user_id: string | null;
  reason: string | null;
  created_at: Generated<Date>;
}

export interface SegmentsTable {
  id: Generated<string>;
  association_id: string;
  season: number;
  episode_start: number;
  episode_end: number | null;
  target_episode_start: number;
  baseline: BaselineSourceRow;
  non_linear: Generated<boolean>;
  needs_review: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ChangeRequestsTable {
  id: Generated<string>;
  status: ChangeRequestStatusRow;
  submitter_user_id: string;
  submitter_key_id: string | null;
  submitter_type: Generated<SubmitterTypeRow>;
  task_id: string | null;
  demand_id: string | null;
  media_id: string | null;
  target_external_key: string;
  namespace: AssociationNamespaceRow;
  raw_native_id: string;
  native_id: string;
  variant_id: string | null;
  variant_description: string | null;
  set_default_variant: Generated<boolean>;
  segments: ColumnType<
    StoredSegmentJson[],
    StoredSegmentJson[] | string | undefined,
    StoredSegmentJson[] | string
  >;
  evidence: ColumnType<
    JsonObject | null,
    JsonObject | string | null | undefined,
    JsonObject | string | null
  >;
  conflict_reason: string | null;
  decision_reason: string | null;
  reviewer_user_id: string | null;
  reviewed_at: Date | null;
  applied_association_id: string | null;
  applied_revision_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface LeadsTable {
  id: Generated<string>;
  target_external_key: string;
  namespace: string;
  native_id: string;
  season: number | null;
  variant_description: string | null;
  notes: string | null;
  reporter_user_id: string;
  reporter_key_id: string;
  /** Corrected segments from a review agent correction; null on client leads. */
  segments: ColumnType<
    LeadSegmentJson[] | null,
    LeadSegmentJson[] | string | null | undefined,
    LeadSegmentJson[] | string | null
  >;
  created_at: Generated<Date>;
}

export type LeadSegmentJson = Pick<
  StoredSegmentJson,
  "season" | "episodeStart" | "episodeEnd" | "targetEpisodeStart"
>;

export interface PlatformChecksTable {
  id: Generated<string>;
  media_id: string;
  platform: PlatformNamespaceRow;
  status: PlatformCheckStatusRow;
  checked_at: Date;
  attempt_count: Generated<number>;
  next_retry_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type ReviewAlertStatusRow = "open" | "resolved";

export interface SyncStateTable {
  sync_key: string;
  last_synced_date: string;
  metadata: ColumnType<JsonObject, JsonObject | string | undefined, JsonObject | string>;
  updated_at: Generated<Date>;
}

export interface ReviewAlertsTable {
  id: Generated<string>;
  alert_type: string;
  media_id: string | null;
  association_id: string | null;
  status: Generated<ReviewAlertStatusRow>;
  details: ColumnType<JsonObject, JsonObject | string | undefined, JsonObject | string>;
  created_at: Generated<Date>;
  resolved_at: Date | null;
  resolved_by_user_id: string | null;
}

export interface DemandsTable {
  id: Generated<string>;
  media_id: string | null;
  external_key: string | null;
  season: number | null;
  namespace_group: DemandNamespaceGroupRow;
  demand_count: Generated<number>;
  status: Generated<DemandStatusRow>;
  not_found_count: Generated<number>;
  next_eligible_at: Generated<Date>;
  last_explored_at: Date | null;
  lease_generation: Generated<number>;
  lease_expires_at: Date | null;
  last_demanded_at: Generated<Date>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type InvalidationReporterTypeRow = "user" | "api_key";

export interface InvalidationReportsTable {
  id: Generated<string>;
  association_id: string;
  reporter_type: InvalidationReporterTypeRow;
  reporter_user_id: string | null;
  reporter_key_id: string | null;
  reason: string | null;
  recheck_job_id: string | null;
  created_at: Generated<Date>;
}

export interface ExplorationDailyBudgetTable {
  budget_date: string;
  consumed: Generated<number>;
  /** bigint: comes back as a string. */
  tokens_used: Generated<string>;
  /** That day's totals per model, as submitted to tokens.ci (`PiUsageTotals` in core). */
  pi_usage: ColumnType<JsonObject, JsonObject | string | undefined, JsonObject | string>;
  /** Change requests the review agent reviewed that day. */
  review_consumed: Generated<number>;
  updated_at: Generated<Date>;
}

export interface TmdbDailyExportIdsTable {
  media_type: MediaTypeRow;
  tmdb_id: string;
  exported_date: string;
}

export interface Database {
  schema_meta: SchemaMetaTable;
  user: UserTable;
  session: SessionTable;
  account: AccountTable;
  verification: VerificationTable;
  background_jobs: BackgroundJobsTable;
  apikey: ApiKeyTable;
  media: MediaTable;
  namespaces: NamespacesTable;
  variants: VariantsTable;
  associations: AssociationsTable;
  association_revisions: AssociationRevisionsTable;
  segments: SegmentsTable;
  change_requests: ChangeRequestsTable;
  leads: LeadsTable;
  platform_checks: PlatformChecksTable;
  sync_state: SyncStateTable;
  review_alerts: ReviewAlertsTable;
  demands: DemandsTable;
  invalidation_reports: InvalidationReportsTable;
  exploration_daily_budget: ExplorationDailyBudgetTable;
  tmdb_daily_export_ids: TmdbDailyExportIdsTable;
}
