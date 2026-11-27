# `@media-ref/api`

Cloudflare Worker (`api.mediaref.org`) serving ConnectRPC Protobuf services (`@connectrpc/connect` directly on Web Fetch API — zero HTTP framework middleware), Better Auth (`/api/auth/*`), Kysely (`@media-ref/db`), and the shared outbound call layer (`@media-ref/core`).

## Protocol & Services

All business endpoints are defined in [`proto/mediaref/v1/`](../../proto/mediaref/v1/) and dispatched through a module-level singleton `createConnectRouter` with per-request `ContextValues`:

| Service (`mediaref.v1`) | RPCs                                                                                                                                                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MediaService`          | `GetMedia`, `BatchGetMedia`                                                                                                                                                                                                                                             |
| `BrowseService`         | `ListTrending`, `GetCatalogDetail`, `Search`, `ListDemands`, `ListExplorationActivity`                                                                                                                                                                                  |
| `ChangeRequestService`  | `CreateChangeRequest`, `GetChangeRequest`, `ListMyChangeRequests`, `CreateChangeRequestComment`, `ListChangeRequestComments`                                                                                                                                            |
| `AssociationService`    | `ReportInvalidation`, `ListAssociationRevisions`                                                                                                                                                                                                                        |
| `AccountService`        | `GetCurrentUser`, `GetCurrentApiKey`, `CreateApiKey`, `ListApiKeys`, `DeleteApiKey`, `UpdateApiKey`, `GetApiUsage`                                                                                                                                                      |
| `ReviewerService`       | `ListChangeRequests`, `ApproveChangeRequest`, `RejectChangeRequest`, `SetAssociationLock`, `OverrideMediaExternalId`, `SetMediaExternalIdLock`, `MergeMedia`, `SwitchMediaBaseline`, `ListReviewAlerts`, `ResolveReviewAlert`, `ListNeedsReviewSegments`, `SetUserRole` |

`GetMedia` supports HTTP GET and accepts a structured `MediaRef`. `BatchGetMedia` accepts repeated refs. `CreateChangeRequestComment` requires a signed-in session and allows 20 comments per day. `ApproveChangeRequest` and `RejectChangeRequest` return `FailedPrecondition` (`DECIDED_BY_REVIEW_AGENT`). People can comment and the review agent verifies the evidence (ADR 0003, amendment 2).

Supported wire protocols on every RPC path (`/mediaref.v1.<Service>/<Method>`):

- **Connect binary Protobuf** (`Content-Type: application/proto`, default in `@media-ref/client`)
- **Connect JSON** (`Content-Type: application/json`, strict unknown-field validation)
- **Connect HTTP GET** (for `NO_SIDE_EFFECTS` read RPCs)
- **gRPC-Web** (`application/grpc-web+proto`)

Non-RPC HTTP/JSON routes:

- `GET /health`
- `GET|POST /api/auth/*` (Better Auth email/password + GitHub & Trakt OAuth)

## Entrypoints & Bindings

- Wrangler loads [`src/worker.ts`](./src/worker.ts), whose default export serves public requests and whose named `InternalApi` entrypoint serves website requests through a service binding, both using the request handler in [`src/index.ts`](./src/index.ts).
- `createApiApp(deps)` in [`src/app.ts`](./src/app.ts) (re-exported via [`src/lib.ts`](./src/lib.ts)): creates the Fetch-based ConnectRPC + Better Auth app with explicit `dbRead`, `dbWrite`, `outbound`, and `config` dependencies.
- Wrangler config in [`wrangler.jsonc`](./wrangler.jsonc) enables `nodejs_compat` and declares `HYPERDRIVE_READ` and `HYPERDRIVE_WRITE`.

## Environment

For local overrides, copy the entries you need from [`.dev.vars.example`](./.dev.vars.example) into `.dev.vars`. Configure resource bindings in [`wrangler.jsonc`](./wrangler.jsonc). The production column describes the checked-in Wrangler configuration.

| Settings or bindings                                                                                                                | Required for                                    | Code default and production configuration                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HYPERDRIVE_READ`, `HYPERDRIVE_WRITE`                                                                                               | All requests                                    | Production binds a cached read connection and an uncached write connection.                                                                                            |
| `AUTH_SECRET`                                                                                                                       | All Worker requests                             | Both the public and `InternalApi` entrypoints require a nonblank signing secret before routing, even for local `GET /health`.                                          |
| `API_BASE_URL`, `COOKIE_DOMAIN`, `TRUSTED_ORIGINS`                                                                                  | Optional                                        | The default API origin is `https://api.mediaref.org`. Cookies default to host-only. Production shares cookies across `mediaref.org` and adds the apex and www origins. |
| `EMAIL`, `EMAIL_FROM`                                                                                                               | `EMAIL` for verification email, sender optional | Production binds email delivery and uses the default noreply sender.                                                                                                   |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `TRAKT_CLIENT_ID`, `TRAKT_CLIENT_SECRET`                                                | Corresponding OAuth provider                    | Each login provider needs both credentials. Trakt catalog requests also use the client ID.                                                                             |
| `TMDB_ACCESS_TOKEN`, `TMDB_API_KEY`, `TVDB_BEARER_TOKEN`                                                                            | Authenticated catalog requests                  | TMDB prefers the bearer token over the API key. TVDB uses its bearer token.                                                                                            |
| `TMDB_API_BASE_URL`, `TVDB_API_BASE_URL`, `DOUBAN_API_BASE_URL`, `BANGUMI_API_BASE_URL`, `IMDB_API_BASE_URL`, `TRAKT_API_BASE_URL`  | Optional                                        | Each adapter defaults to its upstream endpoint.                                                                                                                        |
| `OUTBOUND_PROXY_CONFIG`, `HK`                                                                                                       | Optional routing, `HK` required for egress      | Direct by default. Production routes Bilibili and Youku through `HK`.                                                                                                  |
| `RATE_LIMITER_READ_KEY`, `RATE_LIMITER_READ_IP`                                                                                     | Optional                                        | Production binds Cloudflare rate limiters. Each missing binding uses an in-memory counter.                                                                             |
| `RATE_LIMIT_READ_KEY_LIMIT`, `RATE_LIMIT_READ_IP_LIMIT`, `RATE_LIMIT_READ_PERIOD_SECONDS`, `RATE_LIMIT_READ_RETRY_AFTER_SECONDS`    | Optional                                        | Defaults are 120 reads per key and 300 per IP in 60 seconds, with a 60-second retry delay.                                                                             |
| `RATE_LIMIT_SUBMIT_BASE_HOURLY`, `RATE_LIMIT_SUBMIT_WINDOW_SECONDS`, `RATE_LIMIT_REPUTATION_TIERS`, `RATE_LIMIT_ROLE_HOURLY_LIMITS` | Optional                                        | Base quota is 5 per 3,600 seconds. Reputation tiers and roles can raise it.                                                                                            |
| `INVALIDATION_ANON_THRESHOLD`                                                                                                       | Optional                                        | The anonymous report threshold defaults to 3.                                                                                                                          |
| `API_USAGE`, `CF_ACCOUNT_ID`, `ANALYTICS_API_TOKEN`                                                                                 | Usage reporting                                 | The dataset binding records usage. Queries need the account ID and token. Production declares the dataset and account.                                                 |

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
