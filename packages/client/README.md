# `@media-ref/client`

TypeScript client and Protobuf/ConnectRPC contract package for [media-ref](https://mediaref.org) — an open database mapping movies and TV media to video platform collections and catalog entries down to season/episode segments.

Built on `@bufbuild/protobuf` + `@connectrpc/connect` + `@connectrpc/connect-web` with default **binary Protobuf** (`application/proto`) framing and full Connect JSON / Connect HTTP GET interoperability. Pure domain helpers (`resolveEpisode`, segment validators, external-key parsers) remain side-effect-free and tree-shakeable.

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
  // useBinaryFormat: true, // default: binary Protobuf (application/proto); set false for Connect JSON
  // useHttpGet: false,     // set true to use Connect HTTP GET for side-effect-free GetMedia calls
  // fetch: customFetch,
});
```

### Query a Single Media and Resolve an Episode

```ts
const res = await client.getMedia(
  { tmdb: { type: "tv", id: 95479 } },
  {
    season: 1,
    namespaceGroup: "platform",
  },
);

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

- `getMedia` calls `mediaref.v1.MediaService/GetMedia` using a structured `mediaref.v1.MediaRef` `oneof` on the wire.
- Accepts a structured `MediaRef` (`{ mediaId: "<uuid>" }`, `{ tmdb: { type: "tv", id: 95479 } }`, `{ trakt: { id: "159384", type: "tv" } }`, `{ imdb: "tt12343534" }`, `{ tvdb: { id: 377543, type: "tv" } }`, `{ douban: "1292052" }`, `{ bangumi: "294993" }`, `{ platform: { platform: "bilibili", nativeId: "ss45574" } }`), a raw `proto.MediaRef`, a media UUID, or a legacy external-key string / `ExternalKey` (automatically parsed into `MediaRef`).
- Returns `null` when the server responds with `Code.NotFound`.
- Supports `includeUnconfirmed`, `season`, `namespaceGroup`, and `signal` (`AbortSignal`).

### One-Step Lookup + Episode Resolution (`resolveFromKey`)

```ts
const resolved = await client.resolveFromKey(
  { tmdb: { type: "tv", id: 95479 } },
  {
    namespace: "bilibili",
    season: 1,
    episode: 30,
  },
);

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

`mediaref.v1.MediaService/BatchGetMedia` supports up to 100 `MediaRef` entries per RPC request. By default (`autoChunk: true`), `getMediaBatch` splits larger lists into sequential `<= 100`-entry requests while preserving exact input order and per-entry `ok: false` results:

```ts
const batch = await client.getMediaBatch(
  [
    { tmdb: { type: "tv", id: 95479 } },
    { trakt: { id: "159384", type: "tv" } },
    { douban: "1292052" },
    { platform: { platform: "bilibili", nativeId: "ss45574" } },
  ],
  {
    includeUnconfirmed: false,
    namespaceGroup: "platform",
  },
);

for (const entry of batch.results) {
  if (entry.ok) {
    console.log(entry.ref, entry.items[0]?.document.media.snapshot.title);
  } else {
    console.warn(entry.ref, entry.error, entry.message);
  }
}
```

Pass `{ autoChunk: false }` if you want arrays larger than 100 entries to throw a `RangeError` locally instead of issuing multiple RPC requests.

### Direct ConnectRPC / Protobuf Usage

For advanced callers (e.g. Browse, ChangeRequest, Association, Account, or Reviewer services), `@media-ref/client` exports both the transport helper and all generated Protobuf-ES v2 schemas under `@media-ref/client/proto` (and as `proto` on the root entrypoint):

```ts
import { createClient } from "@connectrpc/connect";
import { createMediaRefTransport, proto } from "@media-ref/client";

const transport = createMediaRefTransport({
  baseUrl: "https://api.mediaref.org",
  apiKey: process.env.MEDIA_REF_API_KEY!,
});
const media = createClient(proto.MediaService, transport);
const res = await media.getMedia({
  ref: {
    id: {
      case: "tmdb",
      value: { type: proto.MediaType.TV, id: 95479 },
    },
  },
});
```

### Error Handling (`MediaRefApiError`)

Non-OK ConnectRPC responses (other than `NotFound` on `getMedia`) throw `MediaRefApiError` with typed `status`, `code` (from structured `mediaref.v1.ErrorInfoDetail`), `message`, and `retryAfterSeconds` (from `Retry-After` response header or `ErrorInfoDetail` on `429`):

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

All pure domain functions can be used offline without creating a ConnectRPC client:

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

- **ConnectRPC Client**: `createMediaRefClient`, `createMediaRefTransport`, `MediaRefApiError`, `DEFAULT_BASE_URL`, `MAX_BATCH_MEDIA_KEYS`, and request/response types (`MediaRefClient`, `MediaRefClientOptions`, `MediaRefTransportOptions`, `FetchLike`, `MediaLookupKey`, `GetMediaOptions`, `GetMediaResponse`, `MediaQueryItem`, `GetMediaBatchOptions`, `BatchMediaItemErrorCode`, `BatchMediaItemResult`, `BatchMediaResponse`, `ResolveFromKeyResult`, `NotFoundResolutionResult`, `MediaRefApiErrorOptions`).
- **Generated Protobuf Schemas & Mappers**: `proto` namespace (and `@media-ref/client/proto` subpath), service descriptors (`MediaService`, `BrowseService`, `ChangeRequestService`, `AssociationService`, `AccountService`, `ReviewerService`), `ErrorInfoDetailSchema`, structured `MediaRef` helpers (`toProtoMediaRef`, `toProtoMediaRefFromKey`, `toProtoMediaRefFromInput`, `fromProtoMediaRef`, `parseMediaRefFromKey`, `formatMediaRefKey`), and bidirectional mappers (`toProtoMediaDocument`, `fromProtoMediaDocument`, `toProtoSegmentInput`, `fromProtoSegmentInput`, `createDomainConnectError`, `extractConnectErrorInfo`, etc.).
- **Episode Resolution**: `resolveEpisode` and result/query types (`ResolveEpisodeQuery`, `ResolveEpisodeResult`, `MappedEpisodeResult`, `CollectionOnlyResult`, `UnmappedEpisodeResult`).
- **Segment Validation**: `normalizeSegment`, `normalizeSegments`, `validateSegment`, `validateVariantSegments`, `validateSharedCollectionSegments`.
- **Domain Types & Helpers**: `MediaRef`, `TmdbRef`, `TvdbRef`, `TraktRef`, `PlatformRef`, `Media`, `MediaSnapshot`, `SeasonSnapshot`, `MediaDocument`, `Variant`, `Association`, `Segment`, `SegmentInput`, `ExternalId`, `ExternalKey`, `PLATFORM_NAMESPACES`, `CATALOG_NAMESPACES`, `BASELINE_PRIORITY`, `getNamespaceGroup`, `parseExternalKey`, `formatExternalKey`.
