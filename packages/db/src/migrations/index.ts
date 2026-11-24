import type { Migration, MigrationProvider } from "kysely/migration";
import * as m0001Initial from "./0001_initial.ts";
import * as m0002Auth from "./0002_auth.ts";
import * as m0003BackgroundJobs from "./0003_background_jobs.ts";
import * as m0004ApiKeys from "./0004_api_keys.ts";
import * as m0005MediaDomain from "./0005_media_domain.ts";
import * as m0006Leads from "./0006_leads.ts";
import * as m0007PlatformStatus from "./0007_platform_status.ts";
import * as m0008ReputationRateLimits from "./0008_reputation_rate_limits.ts";
import * as m0009SyncState from "./0009_sync_state.ts";
import * as m0010Demands from "./0010_demands.ts";
import * as m0011InvalidationReports from "./0011_invalidation_reports.ts";
import * as m0012ExplorationBudget from "./0012_exploration_budget.ts";
import * as m0013UnifiedAssociations from "./0013_unified_associations.ts";

export const migrations: Record<string, Migration> = {
  "0001_initial": m0001Initial,
  "0002_auth": m0002Auth,
  "0003_background_jobs": m0003BackgroundJobs,
  "0004_api_keys": m0004ApiKeys,
  "0005_media_domain": m0005MediaDomain,
  "0006_leads": m0006Leads,
  "0007_platform_status": m0007PlatformStatus,
  "0008_reputation_rate_limits": m0008ReputationRateLimits,
  "0009_sync_state": m0009SyncState,
  "0010_demands": m0010Demands,
  "0011_invalidation_reports": m0011InvalidationReports,
  "0012_exploration_budget": m0012ExplorationBudget,
  "0013_unified_associations": m0013UnifiedAssociations,
};

export const staticMigrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations;
  },
};
