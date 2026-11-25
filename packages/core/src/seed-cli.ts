import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDb } from "@media-ref/db";
import {
  createLiveOutboundClient,
  parseOutboundProxyConfig,
  type ExternalHttpRequest,
  type ExternalHttpResponse,
  type OutboundClient,
} from "./outbound.ts";
import {
  createSeedLeadsReporter,
  importBangumiDataSeeds,
  importDoubanBridgeSeeds,
  importDoubanMovieSeeds,
  importWikidataMovieSeeds,
  type BangumiDataInput,
  type DoubanBridgeInput,
  type DoubanMovieSeedInput,
  type SeedImportSummary,
  type SeedSource,
  type WikidataMovieSeedInput,
} from "./seeds.ts";

const VALID_SOURCES = new Set<SeedSource>([
  "wikidata",
  "douban-movies",
  "bangumi-data",
  "douban-bridge",
]);

const DEFAULT_DOUBAN_BRIDGE_CONCURRENCY = 6;
const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);
const CLI_DOUBAN_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

export type ParsedSeedCliArgs =
  | { kind: "help" }
  | {
      kind: "run";
      source: SeedSource;
      file: string;
      databaseUrl?: string;
      tmdbAccessToken?: string;
      tmdbApiKey?: string;
      tmdbApiBaseUrl?: string;
      noOutbound: boolean;
      dryRun: boolean;
      concurrency?: number;
    };

export const SEED_CLI_USAGE = [
  "Usage: vpx packages/core/src/seed-cli.ts --source <source> --file <path> [options]",
  "",
  "Sources:",
  "  wikidata       Wikidata SPARQL JSON or normalized rows with P4947 + P4529",
  "  douban-movies  Douban movie records ({ doubanId, imdbId }) resolved via TMDB /3/find",
  "  bangumi-data   bangumi-data JSON ({ items: [...] } or items array)",
  "  douban-bridge  douban-bridge douban_mapping rows JSON/NDJSON",
  "",
  "Options:",
  "  --database-url <url>         PostgreSQL connection string (default: $DATABASE_URL)",
  "  --tmdb-access-token <token>  TMDB v3 Bearer token (default: $TMDB_ACCESS_TOKEN)",
  "  --tmdb-api-key <key>         TMDB v3 API key (default: $TMDB_API_KEY)",
  "  --tmdb-api-base-url <url>    TMDB v3 API base URL (default: $TMDB_API_BASE_URL)",
  "  --concurrency <n>            Concurrent outbound resolutions for douban-bridge (default: 6)",
  "  --no-outbound                Disable outbound HTTP lookups during import",
  "  --dry-run                    douban-bridge only: classify and count rows without writing",
  "  --help                       Show this help message",
].join("\n");

export function parseSeedCliArgs(argv: readonly string[]): ParsedSeedCliArgs {
  let source: SeedSource | undefined;
  let file: string | undefined;
  let databaseUrl: string | undefined;
  let tmdbAccessToken: string | undefined;
  let tmdbApiKey: string | undefined;
  let tmdbApiBaseUrl: string | undefined;
  let noOutbound = false;
  let dryRun = false;
  let concurrency: number | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      return { kind: "help" };
    }
    if (arg === "--no-outbound") {
      noOutbound = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    const next = argv[i + 1];
    if (arg === "--source" || arg === "-s") {
      if (!next || !VALID_SOURCES.has(next as SeedSource)) {
        throw new Error(
          `Invalid --source value "${next ?? ""}". Expected one of: wikidata, douban-movies, bangumi-data, douban-bridge`,
        );
      }
      source = next as SeedSource;
      i += 1;
      continue;
    }
    if (arg === "--file" || arg === "-f") {
      if (!next) {
        throw new Error("--file requires a path argument");
      }
      file = next;
      i += 1;
      continue;
    }
    if (arg === "--database-url") {
      if (!next) {
        throw new Error("--database-url requires a value");
      }
      databaseUrl = next;
      i += 1;
      continue;
    }
    if (arg === "--tmdb-access-token") {
      if (!next) {
        throw new Error("--tmdb-access-token requires a value");
      }
      tmdbAccessToken = next;
      i += 1;
      continue;
    }
    if (arg === "--tmdb-api-key") {
      if (!next) {
        throw new Error("--tmdb-api-key requires a value");
      }
      tmdbApiKey = next;
      i += 1;
      continue;
    }
    if (arg === "--tmdb-api-base-url") {
      if (!next) {
        throw new Error("--tmdb-api-base-url requires a value");
      }
      tmdbApiBaseUrl = next;
      i += 1;
      continue;
    }
    if (arg === "--concurrency") {
      if (!next || !/^[1-9]\d*$/.test(next)) {
        throw new Error("--concurrency requires a positive integer");
      }
      concurrency = Number.parseInt(next, 10);
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!source) {
    throw new Error("Missing required --source argument");
  }
  if (!file) {
    throw new Error("Missing required --file argument");
  }
  if (dryRun && source !== "douban-bridge") {
    throw new Error("--dry-run is only supported for --source douban-bridge");
  }

  return {
    kind: "run",
    source,
    file,
    databaseUrl,
    tmdbAccessToken,
    tmdbApiKey,
    tmdbApiBaseUrl,
    noOutbound,
    dryRun,
    concurrency,
  };
}

export interface SeedCliOutboundOptions {
  maxTmdbRetries?: number;
  maxDoubanRetries?: number;
  doubanMinIntervalMs?: number;
  baseRetryDelayMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  nowImpl?: () => number;
}

function parseRetryAfterMs(headers: Record<string, string>): number | null {
  const raw = headers["retry-after"];
  if (!raw) {
    return null;
  }
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(30_000, Math.max(250, Math.ceil(seconds * 1000)));
  }
  return null;
}

/**
 * Wraps an OutboundClient for long-running CLI imports: retries transient TMDB/Douban 429/5xx
 * responses with Retry-After/exponential backoff and paces Douban calls sequentially.
 */
export function createSeedCliOutboundClient(
  baseOutbound: OutboundClient,
  options: SeedCliOutboundOptions = {},
): OutboundClient {
  const maxTmdbRetries = options.maxTmdbRetries ?? 4;
  const maxDoubanRetries = options.maxDoubanRetries ?? 1;
  const doubanMinIntervalMs = options.doubanMinIntervalMs ?? 350;
  const baseRetryDelayMs = options.baseRetryDelayMs ?? 500;
  const sleep =
    options.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.nowImpl ?? Date.now;

  let doubanQueue: Promise<void> = Promise.resolve();
  let lastDoubanCallAt = 0;

  async function runWithRetries(
    request: ExternalHttpRequest,
    maxRetries: number,
  ): Promise<ExternalHttpResponse> {
    let lastResponse: ExternalHttpResponse | null = null;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) {
        const retryAfterMs = lastResponse ? parseRetryAfterMs(lastResponse.headers) : null;
        const backoffMs = retryAfterMs ?? Math.min(15_000, baseRetryDelayMs * 2 ** (attempt - 1));
        await sleep(backoffMs);
      }

      try {
        const response = await baseOutbound.fetchExternal(request);
        if (!RETRYABLE_HTTP_STATUSES.has(response.status) || attempt === maxRetries) {
          return response;
        }
        lastResponse = response;
        lastError = undefined;
      } catch (error) {
        lastError = error;
        lastResponse = null;
        if (attempt === maxRetries) {
          throw error;
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Seed CLI outbound retry exhausted");
  }

  async function runSerializedDouban(request: ExternalHttpRequest): Promise<ExternalHttpResponse> {
    const headers = request.headers?.["user-agent"]
      ? request.headers
      : { ...request.headers, "user-agent": CLI_DOUBAN_USER_AGENT };
    const normalizedRequest: ExternalHttpRequest = { ...request, headers };

    const resultPromise = doubanQueue.then(async () => {
      const waitMs = doubanMinIntervalMs - (now() - lastDoubanCallAt);
      if (lastDoubanCallAt > 0 && waitMs > 0) {
        await sleep(waitMs);
      }
      try {
        return await runWithRetries(normalizedRequest, maxDoubanRetries);
      } finally {
        lastDoubanCallAt = now();
      }
    });

    doubanQueue = resultPromise.then(
      () => undefined,
      () => undefined,
    );
    return resultPromise;
  }

  return {
    fetchExternal(request) {
      if (request.namespace === "douban") {
        return runSerializedDouban(request);
      }
      if (request.namespace === "tmdb") {
        return runWithRetries(request, maxTmdbRetries);
      }
      return baseOutbound.fetchExternal(request);
    },
    sendEmail: (message) => baseOutbound.sendEmail(message),
    invokeModel: (request) => baseOutbound.invokeModel(request),
  };
}

export function parseSeedFileText(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // Fallback to NDJSON (one JSON object per non-empty line)
    const lines = trimmed.split(/\r?\n/);
    const parsedRows: unknown[] = [];
    for (const line of lines) {
      const clean = line.trim();
      if (clean.length === 0) {
        continue;
      }
      parsedRows.push(JSON.parse(clean));
    }
    return parsedRows;
  }
}

export async function runSeedCli(argv: readonly string[]): Promise<SeedImportSummary | null> {
  const parsed = parseSeedCliArgs(argv);
  if (parsed.kind === "help") {
    console.log(SEED_CLI_USAGE);
    return null;
  }

  const databaseUrl = parsed.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable or --database-url is required");
  }

  const fileContent = await readFile(parsed.file, "utf8");
  const payload = parseSeedFileText(fileContent);

  const outbound = parsed.noOutbound
    ? undefined
    : createSeedCliOutboundClient(
        createLiveOutboundClient({
          proxyConfig: parseOutboundProxyConfig(process.env.OUTBOUND_PROXY_CONFIG),
        }),
      );

  const tmdbConfig = {
    accessToken: parsed.tmdbAccessToken ?? process.env.TMDB_ACCESS_TOKEN,
    apiKey: parsed.tmdbApiKey ?? process.env.TMDB_API_KEY,
    apiBaseUrl: parsed.tmdbApiBaseUrl ?? process.env.TMDB_API_BASE_URL,
  };

  const db = createDb(databaseUrl);
  try {
    let summary: SeedImportSummary;
    switch (parsed.source) {
      case "wikidata":
        summary = await importWikidataMovieSeeds(db, payload as WikidataMovieSeedInput);
        break;
      case "douban-movies":
        if (!outbound) {
          throw new Error("--source douban-movies requires outbound TMDB /3/find access");
        }
        summary = await importDoubanMovieSeeds(db, payload as DoubanMovieSeedInput, outbound, {
          tmdbConfig,
        });
        break;
      case "bangumi-data":
        summary = await importBangumiDataSeeds(db, payload as BangumiDataInput, {
          outbound,
          leadsReporter: createSeedLeadsReporter(db),
        });
        break;
      case "douban-bridge": {
        const concurrency =
          parsed.concurrency ?? (outbound ? DEFAULT_DOUBAN_BRIDGE_CONCURRENCY : 1);
        const startedAt = Date.now();
        let lastLoggedCompleted = 0;
        summary = await importDoubanBridgeSeeds(db, payload as DoubanBridgeInput, {
          outbound,
          tmdbConfig,
          leadsReporter: createSeedLeadsReporter(db),
          dryRun: parsed.dryRun,
          concurrency,
          onProgress({ completed, total, summary: s }) {
            if (completed === total || completed - lastLoggedCompleted >= 250) {
              lastLoggedCompleted = completed;
              const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
              console.error(
                `[seed-cli] douban-bridge ${completed}/${total} (${elapsedSec}s): movies=${s.classifiedMovies} singleTv=${s.classifiedSingleSeasonTv} nonMovie=${s.skippedNonMovie} unresolvable=${s.skippedUnresolvable} ambiguous=${s.skippedAmbiguous}`,
              );
            }
          },
        });
        break;
      }
    }

    console.log(JSON.stringify(summary, null, 2));
    return summary;
  } finally {
    await db.destroy();
  }
}

const invokedPath = process.argv[1];
const isDirectExecution =
  typeof invokedPath === "string" && import.meta.url === pathToFileURL(resolve(invokedPath)).href;

if (isDirectExecution) {
  await runSeedCli(process.argv.slice(2));
}
