import { toJson } from "@bufbuild/protobuf";
import { ConnectError, createClient } from "@connectrpc/connect";
import {
  BASELINE_PRIORITY,
  MAX_BATCH_MEDIA_KEYS,
  MediaRefApiError,
  NAMESPACES,
  PLATFORM_NAMESPACES,
  createMediaRefClient,
  extractConnectErrorInfo,
  proto,
  toProtoMediaRefFromKey,
  toProtoSegmentInput,
} from "@media-ref/client";
import { createMcpHandler, McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { extractApiKeyFromHeaders } from "./api-keys.ts";

export const MCP_PATH = "/mcp";

const SERVER_INSTRUCTIONS = `MediaRef maps movies and TV shows to their pages on Chinese video platforms (tencent, iqiyi, youku, bilibili, mgtv), down to season and episode.
Refer to a title with a media key: "tmdb:tv:1429", "tmdb:movie:550", "imdb:tt0944947", "tvdb:series:121361", "trakt:show:game-of-thrones", "douban:1292052", "bangumi:253", a platform key such as "bilibili:ss34430", or a MediaRef media id.
To find where an episode plays, call resolve_episode. Use search when you only have a title. Write tools need an API key with the matching permission; what you submit is evidence that MediaRef's own checks approve or reject.`;

const mediaKey = z
  .string()
  .min(1)
  .describe(
    'Media key, e.g. "tmdb:tv:1429", "tmdb:movie:550", "imdb:tt0944947", "douban:1292052", "bangumi:253", "bilibili:ss34430", or a MediaRef media id',
  );
const season = z
  .number()
  .int()
  .min(0)
  .describe("Season number (0 for specials). Limits associations to that season");
const namespaceGroup = z
  .enum(["platform", "catalog"])
  .describe('"platform" for video platforms only, "catalog" for catalogs (tmdb, douban, ...) only');
const includeUnconfirmed = z
  .boolean()
  .describe("Also return associations that MediaRef has not confirmed yet. Defaults to false");

const wholeSeasonSegment = {
  season: z.number().int().min(0).describe("Season of the media, in the baseline's numbering"),
  baseline: z.enum(BASELINE_PRIORITY).describe("Catalog whose season/episode numbering is used"),
  nonLinear: z
    .boolean()
    .optional()
    .describe("The platform orders episodes differently from the baseline"),
  needsReview: z.boolean().optional(),
};
const segmentInput = z
  .union([
    z.object({
      ...wholeSeasonSegment,
      episodeStart: z.number().int().min(1).describe("First episode of the season covered"),
      episodeEnd: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Last episode covered. Omit for an open-ended run"),
      targetEpisodeStart: z
        .number()
        .int()
        .min(1)
        .describe("Episode number on the platform page that episodeStart maps to"),
    }),
    z.object(wholeSeasonSegment).describe("The whole season"),
  ])
  .describe("Which episodes of the media the platform page holds");

const READ = { readOnlyHint: true, openWorldHint: false } as const;

interface ToolError {
  code: string;
  status: number;
  message: string;
  retryAfterSeconds?: number;
  validationErrors?: unknown;
}

function toToolError(error: unknown): ToolError | null {
  if (error instanceof ConnectError) return extractConnectErrorInfo(error);
  if (error instanceof MediaRefApiError) return error;
  // The client validates media keys and seasons before sending anything.
  if (error instanceof RangeError) {
    return { code: "INVALID_ARGUMENT", status: 400, message: error.message };
  }
  return null;
}

async function run(work: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await work()) }] };
  } catch (error) {
    const info = toToolError(error);
    if (!info) throw error;
    const { code, status, message, retryAfterSeconds, validationErrors } = info;
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: code,
            status,
            message,
            retryAfterSeconds,
            validationErrors,
          }),
        },
      ],
    };
  }
}

function mediaRefOrThrow(key: string): proto.MediaRef {
  const ref = toProtoMediaRefFromKey(key);
  if (!ref) throw new RangeError(`Invalid media key: ${key}`);
  return ref;
}

/**
 * One MCP server per HTTP request. Every tool is a client of the public `mediaref.v1` RPCs:
 * `dispatch` sends the RPC through the API Worker's own router, so the caller's API key goes
 * through the same auth, permission and rate-limit checks as a direct RPC call.
 */
function createServer(
  apiKey: string,
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
) {
  const client = createMediaRefClient({ apiKey, fetch, baseUrl: "https://mcp.internal" });
  const browse = createClient(proto.BrowseService, client.transport);
  const association = createClient(proto.AssociationService, client.transport);
  const changeRequest = createClient(proto.ChangeRequestService, client.transport);
  const apiKeys = createClient(proto.ApiKeyService, client.transport);

  const server = new McpServer(
    { name: "mediaref", version: "1.0.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "resolve_episode",
    {
      title: "Resolve an episode to a platform page",
      description:
        'Find where one episode (or a movie) plays on a platform. Returns kind "mapped" with the platform nativeId and the episode number on that page, "collection_only" when only the whole collection is known, "unmapped" with a reason, or "not_found" when MediaRef has no such media.',
      inputSchema: z.object({
        ref: mediaKey,
        namespace: z.enum(NAMESPACES).describe('Platform to look on, e.g. "bilibili"'),
        season: season.optional(),
        episode: z.number().int().min(1).optional().describe("Episode number; omit for movies"),
        variantId: z
          .string()
          .optional()
          .describe("Variant (e.g. a dub) to use instead of the default"),
        includeUnconfirmed: includeUnconfirmed.optional(),
      }),
      annotations: READ,
    },
    ({ ref, includeUnconfirmed: unconfirmed, ...query }) =>
      run(async () => {
        const result = await client.resolveFromKey(mediaRefOrThrow(ref), {
          ...query,
          ...(unconfirmed !== undefined ? { includeUnconfirmed: unconfirmed } : {}),
        });
        if (result.kind === "not_found") return result;
        const { media: found, ...resolution } = result;
        return {
          ...resolution,
          media: {
            key: found.key,
            id: found.document.media.id,
            title: found.document.media.snapshot.title,
          },
        };
      }),
  );

  server.registerTool(
    "get_media",
    {
      title: "Get a media document",
      description:
        "Get one movie or TV show with its external ids, variants and platform associations (each with segments mapping seasons/episodes to the platform page).",
      inputSchema: z.object({
        ref: mediaKey,
        season: season.optional(),
        namespaceGroup: namespaceGroup.optional(),
        includeUnconfirmed: includeUnconfirmed.optional(),
      }),
      annotations: READ,
    },
    ({ ref, ...options }) =>
      run(async () => {
        const found = await client.getMedia(mediaRefOrThrow(ref), options);
        return found ?? { found: false, key: ref };
      }),
  );

  server.registerTool(
    "batch_get_media",
    {
      title: "Get several media documents",
      description: `Like get_media for up to ${MAX_BATCH_MEDIA_KEYS} keys in one call. Each result is ok with items, or an error (INVALID_KEY, NOT_FOUND).`,
      inputSchema: z.object({
        refs: z.array(z.string()).min(1).max(MAX_BATCH_MEDIA_KEYS).describe("Media keys"),
        season: season.optional(),
        namespaceGroup: namespaceGroup.optional(),
        includeUnconfirmed: includeUnconfirmed.optional(),
      }),
      annotations: READ,
    },
    ({ refs, ...options }) =>
      run(() => client.getMediaBatch(refs, { ...options, autoChunk: false })),
  );

  server.registerTool(
    "search",
    {
      title: "Search titles",
      description:
        "Search catalogs by title, catalog/platform URL or media key. Each card has a catalog key (usable as get_media ref or change request target); mediaId and platforms are set when the title is already in MediaRef.",
      inputSchema: z.object({
        query: z.string().min(1).describe("A title, a catalog or platform URL, or a media key"),
        limit: z.number().int().min(1).optional(),
      }),
      annotations: READ,
    },
    (req) => run(async () => toJson(proto.SearchResponseSchema, await browse.search(req))),
  );

  server.registerTool(
    "get_catalog_detail",
    {
      title: "Get catalog details",
      description:
        'Catalog details (overview, genres, credits, seasons with episode counts) for a catalog key such as "tmdb:tv:1429" or "douban:1292052".',
      inputSchema: z.object({ key: z.string().min(1).describe("Catalog key from search") }),
      annotations: READ,
    },
    (req) =>
      run(async () =>
        toJson(proto.GetCatalogDetailResponseSchema, await browse.getCatalogDetail(req)),
      ),
  );

  server.registerTool(
    "list_association_revisions",
    {
      title: "List association revisions",
      description:
        "Revision history of one platform association: who changed it, through which change request, and why.",
      inputSchema: z.object({
        associationId: z.string().min(1),
        order: z.enum(["asc", "desc"]).optional(),
        limit: z.number().int().min(1).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      annotations: READ,
    },
    ({ order, ...req }) =>
      run(async () =>
        toJson(
          proto.ListAssociationRevisionsResponseSchema,
          await association.listAssociationRevisions({
            ...req,
            order:
              order === "asc"
                ? proto.SortOrder.ASC
                : order === "desc"
                  ? proto.SortOrder.DESC
                  : proto.SortOrder.UNSPECIFIED,
          }),
        ),
      ),
  );

  server.registerTool(
    "get_change_request",
    {
      title: "Get a change request",
      description:
        "Status and decision of a change request (pending evidence, approved, rejected), with its evidence and the reason.",
      inputSchema: z.object({ id: z.string().min(1) }),
      annotations: READ,
    },
    (req) =>
      run(async () =>
        toJson(proto.GetChangeRequestResponseSchema, await changeRequest.getChangeRequest(req)),
      ),
  );

  server.registerTool(
    "get_current_api_key",
    {
      title: "Get the current API key",
      description:
        "The API key this server is called with: its permissions (read, report, submit) and owner.",
      annotations: READ,
    },
    () =>
      run(async () =>
        toJson(proto.GetCurrentApiKeyResponseSchema, await apiKeys.getCurrentApiKey({})),
      ),
  );

  server.registerTool(
    "report_invalidation",
    {
      title: "Report a broken association",
      description:
        "Report that a platform association no longer works (page gone, wrong content). Needs the report permission. Reports are deduplicated; enough reports trigger a recheck that MediaRef runs on its own.",
      inputSchema: z.object({
        associationId: z.string().min(1),
        reason: z.string().max(500).optional().describe("What is wrong, in a sentence"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (req) =>
      run(async () =>
        toJson(proto.ReportInvalidationResponseSchema, await association.reportInvalidation(req)),
      ),
  );

  server.registerTool(
    "create_change_request",
    {
      title: "Submit a change request",
      description:
        "Propose a platform page for a media. Needs the submit permission. The request is checked against evidence and approved or rejected automatically; poll get_change_request for the outcome.",
      inputSchema: z.object({
        target: mediaKey.describe("Media the platform page belongs to"),
        namespace: z.enum(PLATFORM_NAMESPACES).describe("Platform of the page"),
        nativeId: z.string().min(1).describe('Platform id of the page, e.g. "ss34430" on bilibili'),
        rawNativeId: z.string().optional().describe("The id or URL as you found it"),
        variantId: z
          .string()
          .optional()
          .describe("Existing variant to attach to. Give this or variantDescription"),
        variantDescription: z.string().optional().describe('New variant label, e.g. "国语"'),
        setDefaultVariant: z.boolean().optional(),
        taskId: z.string().optional(),
        replacesAssociationId: z.string().optional(),
        segments: z.array(segmentInput).describe("Leave empty for a movie"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ target, segments, ...req }) =>
      run(async () =>
        toJson(
          proto.CreateChangeRequestResponseSchema,
          await changeRequest.createChangeRequest({
            ...req,
            target: mediaRefOrThrow(target),
            segments: segments.map(toProtoSegmentInput),
          }),
        ),
      ),
  );

  return server;
}

/**
 * Serves `/mcp`. `dispatch` hands a public RPC request to the API Worker's router; the MCP
 * caller's IP is copied onto it so per-IP read limits count MCP tool calls too.
 */
export async function handleMcpRequest(
  request: Request,
  dispatch: (request: Request) => Promise<Response>,
): Promise<Response> {
  const apiKey = extractApiKeyFromHeaders(request.headers);
  if (!apiKey) {
    return Response.json(
      {
        code: "API_KEY_REQUIRED",
        message: "API key is required (Authorization: Bearer <key> or X-API-Key)",
      },
      { status: 401 },
    );
  }
  const ip = request.headers.get("cf-connecting-ip");
  const fetch = (input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (ip) headers.set("cf-connecting-ip", ip);
    // connect-web asks for redirect "error", which workerd's Request rejects; nothing redirects here.
    return dispatch(new Request(input, { ...init, headers, redirect: "manual" }));
  };
  return createMcpHandler(() => createServer(apiKey, fetch)).fetch(request);
}
