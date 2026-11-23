import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDb } from "@media-ref/db";
import { createLiveOutboundClient, parseOutboundProxyConfig } from "./outbound.ts";
import {
  importBangumiDataSeeds,
  importDoubanBridgeMovieSeeds,
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
  "  --no-outbound                Disable outbound HTTP lookups during import",
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

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      return { kind: "help" };
    }
    if (arg === "--no-outbound") {
      noOutbound = true;
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

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!source) {
    throw new Error("Missing required --source argument");
  }
  if (!file) {
    throw new Error("Missing required --file argument");
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
    : createLiveOutboundClient({
        proxyConfig: parseOutboundProxyConfig(process.env.OUTBOUND_PROXY_CONFIG),
      });

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
        summary = await importBangumiDataSeeds(db, payload as BangumiDataInput, { outbound });
        break;
      case "douban-bridge":
        summary = await importDoubanBridgeMovieSeeds(db, payload as DoubanBridgeInput, {
          outbound,
          tmdbConfig,
        });
        break;
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
