import type {
  Ai,
  ExecutionContext,
  Hyperdrive,
  MessageBatch,
  Queue,
  ScheduledController,
} from "@cloudflare/workers-types";
import {
  createLiveOutboundClient,
  DEFAULT_AI_MODEL,
  DEFAULT_AI_PROVIDER,
  DEFAULT_EXPLORATION_BATCH_SIZE,
  DEFAULT_EXPLORATION_DAILY_BUDGET,
  DEFAULT_EXPLORATION_DAILY_TOKEN_BUDGET,
  DEFAULT_EXPLORATION_LEASE_DURATION_MS,
  DEFAULT_EXPLORATION_MAX_DURATION_MS,
  DEFAULT_EXPLORATION_MAX_STEPS,
  DEFAULT_EXPLORATION_MAX_TASK_TOKENS,
  DEFAULT_NOT_FOUND_BACKOFF_SECONDS,
  parseExplorationBackoffSeconds,
  parseOutboundProxyConfig,
  type EgressFetcher,
  type JobQueueMessage,
} from "@media-ref/core";
import { createDb } from "@media-ref/db";
import {
  createBackgroundWorker,
  DEFAULT_JOB_BATCH_SIZE,
  DEFAULT_LEASE_DURATION_MS,
  type BackgroundWorkerConfig,
} from "./worker.ts";

export {
  createBackgroundWorker,
  DEFAULT_JOB_BATCH_SIZE,
  DEFAULT_LEASE_DURATION_MS,
  DEFAULT_RETRY_DELAY_MS,
  type BackgroundWorker,
  type BackgroundWorkerConfig,
  type BackgroundWorkerDeps,
  type QueueBatchSummary,
  type ScheduledRunSummary,
} from "./worker.ts";

export interface BackgroundWorkerEnv {
  HYPERDRIVE_WRITE: Hyperdrive;
  JOBS_QUEUE: Queue<JobQueueMessage>;
  AI?: Ai;
  AI_GATEWAY_ID?: string;
  AI_PROVIDER?: string;
  AI_MODEL?: string;
  // magpie's gateway key: model calls and web search go to magpie through HK when set.
  MAGPIE_GATEWAY_KEY?: string;
  // tokens.ci API token: the agent's model usage is submitted there as pi, device MediaRef.
  TOKENS_API_TOKEN?: string;
  OUTBOUND_PROXY_CONFIG?: string;
  // Workers VPC service: the greencloud-hk egress relay.
  HK?: EgressFetcher;
  JOB_BATCH_SIZE?: string;
  JOB_LEASE_DURATION_MS?: string;
  EXPLORATION_DAILY_BUDGET?: string;
  EXPLORATION_BATCH_SIZE?: string;
  EXPLORATION_LEASE_DURATION_MS?: string;
  EXPLORATION_BACKOFF_SECONDS?: string;
  EXPLORATION_MAX_STEPS?: string;
  EXPLORATION_MAX_DURATION_MS?: string;
  EXPLORATION_MAX_TASK_TOKENS?: string;
  EXPLORATION_DAILY_TOKEN_BUDGET?: string;
  TMDB_ACCESS_TOKEN?: string;
  TMDB_API_KEY?: string;
  TMDB_API_BASE_URL?: string;
  TMDB_EXPORTS_BASE_URL?: string;
  ENABLE_DAILY_TMDB_EXPORTS_SYNC?: string;
  TVDB_BEARER_TOKEN?: string;
  TVDB_API_BASE_URL?: string;
  DOUBAN_API_BASE_URL?: string;
  BANGUMI_API_BASE_URL?: string;
  IMDB_API_BASE_URL?: string;
  TRAKT_CLIENT_ID?: string;
  TRAKT_API_BASE_URL?: string;
}

function parseOptionalString(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function parseWorkerConfig(env: BackgroundWorkerEnv): BackgroundWorkerConfig {
  const gatewayId = parseOptionalString(env.AI_GATEWAY_ID);
  const tmdb = {
    accessToken: env.TMDB_ACCESS_TOKEN,
    apiKey: env.TMDB_API_KEY,
    apiBaseUrl: env.TMDB_API_BASE_URL,
    traktClientId: env.TRAKT_CLIENT_ID,
    traktApiBaseUrl: env.TRAKT_API_BASE_URL,
  };
  return {
    batchSize: parsePositiveInt(env.JOB_BATCH_SIZE, DEFAULT_JOB_BATCH_SIZE),
    leaseDurationMs: parsePositiveInt(env.JOB_LEASE_DURATION_MS, DEFAULT_LEASE_DURATION_MS),
    enableDailyTmdbExportsSync: env.ENABLE_DAILY_TMDB_EXPORTS_SYNC !== "false",
    tmdbExportsBaseUrl: parseOptionalString(env.TMDB_EXPORTS_BASE_URL),
    exploration: {
      dailyBudget: parseNonNegativeInt(
        env.EXPLORATION_DAILY_BUDGET,
        DEFAULT_EXPLORATION_DAILY_BUDGET,
      ),
      dailyTokenBudget: parseNonNegativeInt(
        env.EXPLORATION_DAILY_TOKEN_BUDGET,
        DEFAULT_EXPLORATION_DAILY_TOKEN_BUDGET,
      ),
      batchSize: parsePositiveInt(env.EXPLORATION_BATCH_SIZE, DEFAULT_EXPLORATION_BATCH_SIZE),
      leaseDurationMs: parsePositiveInt(
        env.EXPLORATION_LEASE_DURATION_MS,
        DEFAULT_EXPLORATION_LEASE_DURATION_MS,
      ),
      notFoundBackoffSeconds: parseExplorationBackoffSeconds(
        env.EXPLORATION_BACKOFF_SECONDS,
        DEFAULT_NOT_FOUND_BACKOFF_SECONDS,
      ),
    },
    explorationAgent: {
      ...(gatewayId ? { gatewayId } : {}),
      provider: parseOptionalString(env.AI_PROVIDER) ?? DEFAULT_AI_PROVIDER,
      model: parseOptionalString(env.AI_MODEL) ?? DEFAULT_AI_MODEL,
      maxSteps: parsePositiveInt(env.EXPLORATION_MAX_STEPS, DEFAULT_EXPLORATION_MAX_STEPS),
      maxDurationMs: parsePositiveInt(
        env.EXPLORATION_MAX_DURATION_MS,
        DEFAULT_EXPLORATION_MAX_DURATION_MS,
      ),
      maxTaskTokens: parsePositiveInt(
        env.EXPLORATION_MAX_TASK_TOKENS,
        DEFAULT_EXPLORATION_MAX_TASK_TOKENS,
      ),
      tokensApiToken: parseOptionalString(env.TOKENS_API_TOKEN),
    },
    tmdb,
    catalog: {
      tmdb,
      tvdbBearerToken: parseOptionalString(env.TVDB_BEARER_TOKEN),
      tvdbApiBaseUrl: parseOptionalString(env.TVDB_API_BASE_URL),
      doubanApiBaseUrl: parseOptionalString(env.DOUBAN_API_BASE_URL),
      bangumiApiBaseUrl: parseOptionalString(env.BANGUMI_API_BASE_URL),
      imdbApiBaseUrl: parseOptionalString(env.IMDB_API_BASE_URL),
      traktClientId: parseOptionalString(env.TRAKT_CLIENT_ID),
      traktApiBaseUrl: parseOptionalString(env.TRAKT_API_BASE_URL),
    },
  };
}

function createWorkerOutboundClient(env: BackgroundWorkerEnv) {
  const magpieKey = parseOptionalString(env.MAGPIE_GATEWAY_KEY);
  return createLiveOutboundClient({
    proxyConfig: parseOutboundProxyConfig(env.OUTBOUND_PROXY_CONFIG),
    egressFetcher: env.HK,
    ...(magpieKey && env.HK ? { magpie: { fetcher: env.HK, apiKey: magpieKey } } : {}),
    aiBinding: env.AI,
    aiGatewayId: parseOptionalString(env.AI_GATEWAY_ID),
    aiProvider: parseOptionalString(env.AI_PROVIDER) ?? DEFAULT_AI_PROVIDER,
    aiModel: parseOptionalString(env.AI_MODEL) ?? DEFAULT_AI_MODEL,
  });
}

const worker = {
  async scheduled(
    controller: ScheduledController,
    env: BackgroundWorkerEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    const db = createDb(env.HYPERDRIVE_WRITE.connectionString, { max: 5 });
    const instance = createBackgroundWorker({
      db,
      outbound: createWorkerOutboundClient(env),
      queue: env.JOBS_QUEUE,
      config: parseWorkerConfig(env),
    });

    try {
      await instance.scheduled(controller, env, ctx);
    } finally {
      ctx.waitUntil(db.destroy());
    }
  },

  async queue(
    batch: MessageBatch<JobQueueMessage>,
    env: BackgroundWorkerEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    const db = createDb(env.HYPERDRIVE_WRITE.connectionString, { max: 5 });
    const instance = createBackgroundWorker({
      db,
      outbound: createWorkerOutboundClient(env),
      queue: env.JOBS_QUEUE,
      config: parseWorkerConfig(env),
    });

    try {
      await instance.queue(batch, env, ctx);
    } finally {
      ctx.waitUntil(db.destroy());
    }
  },
};

export default worker;
