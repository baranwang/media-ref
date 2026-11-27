import type { AnalyticsSQLBinding, Hyperdrive, SendEmail } from "@cloudflare/workers-types";
import type { EgressFetcher } from "@media-ref/core";
import type { RateLimitBinding } from "./rate-limit.ts";

export interface ApiWorkerEnv {
  HYPERDRIVE_READ: Hyperdrive;
  HYPERDRIVE_WRITE: Hyperdrive;
  EMAIL?: SendEmail;
  EMAIL_FROM?: string;
  AUTH_SECRET?: string;
  API_BASE_URL?: string;
  COOKIE_DOMAIN?: string;
  TRUSTED_ORIGINS?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  TRAKT_CLIENT_ID?: string;
  TRAKT_CLIENT_SECRET?: string;
  OUTBOUND_PROXY_CONFIG?: string;
  // Workers VPC service: the greencloud-hk egress relay.
  HK?: EgressFetcher;
  TMDB_ACCESS_TOKEN?: string;
  TMDB_API_KEY?: string;
  TMDB_API_BASE_URL?: string;
  TVDB_BEARER_TOKEN?: string;
  TVDB_API_BASE_URL?: string;
  DOUBAN_API_BASE_URL?: string;
  BANGUMI_API_BASE_URL?: string;
  IMDB_API_BASE_URL?: string;
  TRAKT_API_BASE_URL?: string;
  RATE_LIMITER_READ_KEY?: RateLimitBinding;
  RATE_LIMITER_READ_IP?: RateLimitBinding;
  RATE_LIMIT_READ_KEY_LIMIT?: string;
  RATE_LIMIT_READ_IP_LIMIT?: string;
  RATE_LIMIT_READ_PERIOD_SECONDS?: string;
  RATE_LIMIT_READ_RETRY_AFTER_SECONDS?: string;
  RATE_LIMIT_SUBMIT_BASE_HOURLY?: string;
  RATE_LIMIT_SUBMIT_WINDOW_SECONDS?: string;
  RATE_LIMIT_REPUTATION_TIERS?: string;
  RATE_LIMIT_ROLE_HOURLY_LIMITS?: string;
  INVALIDATION_ANON_THRESHOLD?: string;
  // Analytics Engine dataset for per-key usage, and the Analytics SQL binding used to query it.
  API_USAGE?: {
    writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
  };
  ANALYTICS_SQL?: AnalyticsSQLBinding;
}
