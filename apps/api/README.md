# `@media-ref/api`

Cloudflare Worker (`api.mediaref.org`) serving ConnectRPC Protobuf services (`@connectrpc/connect` directly on Web Fetch API — zero HTTP framework middleware), Better Auth (`/api/auth/*`), Kysely (`@media-ref/db`), and the shared outbound call layer (`@media-ref/core`).

## Protocol & Services

All business endpoints are defined in [`proto/mediaref/v1/`](../../proto/mediaref/v1/) and dispatched through a module-level singleton `createConnectRouter` with per-request `ContextValues`:

- `mediaref.v1.MediaService`: `GetMedia` (`NO_SIDE_EFFECTS` / HTTP GET capable, structured `MediaRef` `oneof`: `media_id` / `tmdb` / `imdb` / `tvdb` / `trakt` / `douban` / `bangumi` / `platform`), `BatchGetMedia` (`repeated MediaRef refs`)
- `mediaref.v1.ChangeRequestService`: `CreateChangeRequest` (`MediaRef target`), `GetChangeRequest`, `CreateChangeRequestComment` (signed-in session only, not an API key; 20 a day), `ListChangeRequestComments`
- `mediaref.v1.AssociationService`: `ReportInvalidation`, `ListAssociationRevisions`
- `mediaref.v1.AccountService`: `GetCurrentUser`, `GetCurrentApiKey`, `CreateApiKey`, `ListApiKeys`, `DeleteApiKey`
- `mediaref.v1.ReviewerService`: `ListChangeRequests`, `ApproveChangeRequest` / `RejectChangeRequest` (no longer decide anything: they answer `FailedPrecondition` `DECIDED_BY_REVIEW_AGENT`, people comment instead, ADR 0003 amendment 2), `SetAssociationLock`, `OverrideMediaExternalId`, `SetMediaExternalIdLock`, `MergeMedia`, `SwitchMediaBaseline`, `ListReviewAlerts`, `ResolveReviewAlert`, `ListNeedsReviewSegments`, `SetUserRole`

Supported wire protocols on every RPC path (`/mediaref.v1.<Service>/<Method>`):

- **Connect binary Protobuf** (`Content-Type: application/proto`, default in `@media-ref/client`)
- **Connect JSON** (`Content-Type: application/json`, strict unknown-field validation)
- **Connect HTTP GET** (for `NO_SIDE_EFFECTS` read RPCs)
- **gRPC-Web** (`application/grpc-web+proto`)

Non-RPC HTTP/JSON routes:

- `GET /health` (and optional `GET /health/outbound` when `ENABLE_HEALTH_OUTBOUND_PROBE=true`)
- `GET|POST /api/auth/*` (Better Auth email/password + GitHub & Trakt OAuth)

## Entrypoints & Bindings

- Default export in [`src/index.ts`](./src/index.ts): clean Cloudflare Worker entrypoint exporting only `default` (required by `workerd`), binding `HYPERDRIVE_READ` (cached Hyperdrive for reads) and `HYPERDRIVE_WRITE` (uncached Hyperdrive for mutations), cleaning up per-request `pg` pools after `ctx.waitUntil(...)` background demand/seed tasks settle.
- `createApiApp(deps)` in [`src/app.ts`](./src/app.ts) (re-exported via [`src/lib.ts`](./src/lib.ts)): creates the Fetch-based ConnectRPC + Better Auth app with explicit `dbRead`, `dbWrite`, `outbound`, and `config` dependencies.
- Wrangler config in [`wrangler.jsonc`](./wrangler.jsonc) enables `nodejs_compat` and declares `HYPERDRIVE_READ` and `HYPERDRIVE_WRITE`.

## Testing Strategy & Workers Pool Verification

Tests run at the Fetch/ConnectRPC entrypoint seam (`app.fetch` and the exported Worker `fetch(request, env, ctx)`) against a real local PostgreSQL 19 instance (via `createTestDb()` from `@media-ref/db/testing`), using `createFakeOutboundClient()` from `@media-ref/core` as the sole test double.

### Empirical findings with Vite+ (`vite-plus@1.7.0`, bundled `vitest@5.1.0`)

1. **`@cloudflare/vitest-pool-workers@0.23.0` is deprecated and incompatible with `vp test` (`vitest@5.1.0`)**:
   - Peer dependencies declare `"vitest": "^4.1.0"`, `"@vitest/runner": "^4.1.0"`, `"@vitest/snapshot": "^4.1.0"`.
   - Deprecation notice: `@cloudflare/vitest-pool-workers has been renamed to @cloudflare/vitest-plugin. This package will not receive future updates.`
2. **Successor `@cloudflare/vitest-plugin@1.9.0`**:
   - Declares `"vitest": "^4.1.0 || ^5.0.0"` and can boot minimal Workers under `vp test`.
   - For API integration tests we intentionally run `vp test` directly in Node against `app.fetch` and the exported Worker `fetch(request, env, ctx)` so tests can provision/drop ephemeral databases directly on local PostgreSQL 19 via `pg` without Hyperdrive and inject per-test fake `OutboundClient` doubles without Miniflare sandbox/loopback constraints. Cloudflare Workers bundle and `workerd` boot compatibility are verified via `wrangler deploy --dry-run` and `wrangler dev --local`.

## Commands

```bash
# Run API Worker tests (requires local PostgreSQL 19 via `vp run db:up`)
vp run @media-ref/api#test

# Verify Cloudflare Worker bundle with Wrangler (dry run)
vp run @media-ref/api#build

# Format, lint, and type-check
vp check apps/api
```
