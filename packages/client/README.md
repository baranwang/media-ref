# `@media-ref/client`

Zero-dependency TypeScript client for [media-ref](https://mediaref.org) — an open database mapping movies and TV media to video platform collections and catalog entries down to season/episode segments.

Works in Node.js 22+, Bun, Deno, Cloudflare Workers, and browsers using standard Web `fetch`.

## Installation

```bash
npm install @media-ref/client
# or
bun add @media-ref/client
```

## Quick Start

### Create a Client

```ts
import { createMediaRefClient, resolveEpisode } from "@media-ref/client";

const client = createMediaRefClient({
  apiKey: process.env.MEDIA_REF_API_KEY!,
  // Optional overrides:
  // baseUrl: "https://api.mediaref.org",
  // fetch: customFetch,
});
```

### Query a Single Media and Resolve an Episode

```ts
const res = await client.getMedia("tmdb:tv:95479", {
  season: 1,
  namespaceGroup: "platform",
});

if (res) {
  const episode = resolveEpisode(res.document, {
    namespace: "bilibili",
    season: 1,
    episode: 30,
  });

  if (episode.kind === "mapped") {
    console.log(episode.nativeId, episode.targetEpisode);
    // e.g. "ss45574" 6
  }
}
```

- `getMedia` accepts a media UUID, an external key string (`"tmdb:tv:95479"`, `"douban:1292052"`, `"bilibili:ss45574"`), or a structured `ExternalKey` (`{ namespace: "tmdb", nativeId: "tv:95479" }`).
- Returns `null` when the API responds with `404`.
- Supports `includeUnconfirmed`, `season`, `namespaceGroup`, and `signal` (`AbortSignal`).

### One-Step Lookup + Episode Resolution (`resolveFromKey`)

```ts
const resolved = await client.resolveFromKey("tmdb:tv:95479", {
  namespace: "bilibili",
  season: 1,
  episode: 30,
});

switch (resolved.kind) {
  case "mapped":
    console.log(
      resolved.nativeId,
      resolved.targetEpisode,
      resolved.media.document.media.snapshot.title,
    );
    break;
  case "collection_only":
    console.log(resolved.nativeId, resolved.reason);
    break;
  case "unmapped":
    console.log("Unmapped:", resolved.reason);
    break;
  case "not_found":
    console.log("Media not found:", resolved.key);
    break;
}
```

### Batch Queries (`getMediaBatch`)

The Read API supports up to 100 keys per `POST /v1/media/batch` request. By default (`autoChunk: true`), `getMediaBatch` splits larger lists into sequential `<= 100`-key requests while preserving exact input order and per-key `ok: false` results:

```ts
const batch = await client.getMediaBatch(
  ["tmdb:tv:95479", { namespace: "douban", nativeId: "1292052" }, "bilibili:ss45574"],
  {
    includeUnconfirmed: false,
    namespaceGroup: "platform",
  },
);

for (const entry of batch.results) {
  if (entry.ok) {
    console.log(entry.key, entry.items[0]?.document.media.snapshot.title);
  } else {
    console.warn(entry.key, entry.error, entry.message);
  }
}
```

Pass `{ autoChunk: false }` if you want arrays larger than 100 keys to throw a `RangeError` locally instead of issuing multiple HTTP requests.

### Reporting a Lead (`reportLead`)

Clients that discover a potential platform or catalog match locally can report it as a non-binding lead for future exploration (requires a standard read/report API key):

```ts
const { lead } = await client.reportLead({
  targetExternalKey: { namespace: "tmdb", nativeId: "tv:95479" },
  namespace: "bilibili",
  nativeId: "ss45574",
  season: 1,
  variantDescription: "原声",
  notes: "Season 1 second cour",
});
```

### Error Handling (`MediaRefApiError`)

Non-2xx responses (other than `404` on `getMedia`) throw `MediaRefApiError` with typed `status`, `code`, `message`, and `retryAfterSeconds` (parsed from `Retry-After` or JSON body on `429`):

```ts
import { MediaRefApiError } from "@media-ref/client";

try {
  await client.getMedia("tmdb:tv:95479");
} catch (error) {
  if (error instanceof MediaRefApiError) {
    if (error.status === 429 && error.retryAfterSeconds !== undefined) {
      console.warn(`Rate limited; retry after ${error.retryAfterSeconds}s`);
    } else {
      console.error(`API error ${error.status} (${error.code}): ${error.message}`);
    }
  }
}
```

## Pure Utilities

All pure domain functions can be used offline without creating an HTTP client:

### Segment Validation (`validateVariantSegments`)

Shared identically by client forms and server transactions to reject overlapping episodes within a variant:

```ts
import { validateVariantSegments } from "@media-ref/client";

const validation = validateVariantSegments([
  {
    associationId: "assoc-ss34430",
    segments: [
      { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" },
    ],
  },
  {
    associationId: "assoc-ss45574",
    segments: [
      { season: 1, episodeStart: 25, episodeEnd: 47, targetEpisodeStart: 1, baseline: "tmdb" },
    ],
  },
]);

if (!validation.valid) {
  console.error(validation.errors);
}
```

### External Key Helpers

```ts
import { formatExternalKey, parseExternalKey } from "@media-ref/client";

const parsed = parseExternalKey("tmdb:tv:95479");
// { namespace: "tmdb", nativeId: "tv:95479" }

const formatted = formatExternalKey({ namespace: "bilibili", nativeId: "ss45574" });
// "bilibili:ss45574"
```

## Exports

- **HTTP Client**: `createMediaRefClient`, `MediaRefApiError`, `DEFAULT_BASE_URL`, `MAX_BATCH_MEDIA_KEYS`, and request/response types (`MediaRefClient`, `MediaRefClientOptions`, `FetchLike`, `MediaLookupKey`, `GetMediaOptions`, `GetMediaResponse`, `MediaQueryItem`, `GetMediaBatchOptions`, `BatchMediaItemErrorCode`, `BatchMediaItemResult`, `BatchMediaResponse`, `ResolveFromKeyResult`, `NotFoundResolutionResult`, `ReportLeadInput`, `ReportLeadOptions`, `LeadRecord`, `ReportLeadResponse`, `MediaRefApiErrorOptions`).
- **Episode Resolution**: `resolveEpisode` and result/query types (`ResolveEpisodeQuery`, `ResolveEpisodeResult`, `MappedEpisodeResult`, `CollectionOnlyResult`, `UnmappedEpisodeResult`).
- **Segment Validation**: `normalizeSegment`, `normalizeSegments`, `validateSegment`, `validateVariantSegments`, `validateSharedCollectionSegments`.
- **Domain Types & Helpers**: `Media`, `MediaSnapshot`, `SeasonSnapshot`, `MediaDocument`, `Variant`, `Association`, `Segment`, `SegmentInput`, `ExternalId`, `ExternalKey`, `PLATFORM_NAMESPACES`, `CATALOG_NAMESPACES`, `BASELINE_PRIORITY`, `getNamespaceGroup`, `parseExternalKey`, `formatExternalKey`.
