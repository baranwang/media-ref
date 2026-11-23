# `@media-ref/api`

Cloudflare Worker (`api.mediaref.org`) built with Hono, Kysely (`@media-ref/db`), and the shared outbound call layer (`@media-ref/core`).

## Entrypoints & Bindings

- `createApiApp(deps)` in [`src/app.ts`](./src/app.ts): creates the Hono HTTP application with explicit `dbRead`, `dbWrite`, `outbound`, and `config` dependencies.
- Default export in [`src/index.ts`](./src/index.ts): Cloudflare Worker `fetch(request, env, ctx)` handler binding `HYPERDRIVE_READ` (cached Hyperdrive for read queries) and `HYPERDRIVE_WRITE` (uncached Hyperdrive for mutations), cleaning up per-request `pg` pools via `ctx.waitUntil(...)`.
- Wrangler config in [`wrangler.jsonc`](./wrangler.jsonc) enables `nodejs_compat` and declares `HYPERDRIVE_READ` and `HYPERDRIVE_WRITE`.

## Testing Strategy & Workers Pool Verification

Tests run at the HTTP entrypoint seam (`app.fetch` and the exported Worker `fetch(request, env, ctx)`) against a real local PostgreSQL 19 instance (via `createTestDb()` from `@media-ref/db/testing`), using `createFakeOutboundClient()` from `@media-ref/core` as the sole test double.

### Empirical findings with Vite+ (`vite-plus@1.7.0`, bundled `vitest@5.1.0`)

1. **`@cloudflare/vitest-pool-workers@0.23.0` is deprecated and incompatible with `vp test` (`vitest@5.1.0`)**:
   - Peer dependencies declare `"vitest": "^4.1.0"`, `"@vitest/runner": "^4.1.0"`, `"@vitest/snapshot": "^4.1.0"`.
   - Deprecation notice: `@cloudflare/vitest-pool-workers has been renamed to @cloudflare/vitest-plugin. This package will not receive future updates.`
   - Executing `vp test --run` fails immediately before any test executes with:
     ```text
     Error: [vitest-pool]: Failed to start cloudflare-pool worker for test files ...
     Caused by: SyntaxError: The requested module '@vitest/utils/display' does not provide an export named 'objDisplay'
     ```
2. **Successor `@cloudflare/vitest-plugin@1.9.0`**:
   - Declares `"vitest": "^4.1.0 || ^5.0.0"` and can boot minimal Workers under `vp test`.
   - For API integration tests we intentionally run `vp test` directly in Node against `app.fetch` and the exported Worker `fetch(request, env, ctx)` so tests can provision/drop ephemeral databases directly on local PostgreSQL 19 via `pg` without Hyperdrive and inject per-test fake `OutboundClient` doubles without Miniflare sandbox/loopback constraints. Cloudflare Workers bundle compatibility is verified separately with `wrangler deploy --dry-run` and `@cloudflare/workers-types`.

## Commands

```bash
# Run API Worker HTTP entrypoint tests (requires local PostgreSQL 19 via docker compose up -d)
vp run @media-ref/api#test

# Verify Cloudflare Worker bundle with Wrangler (dry run)
vp run @media-ref/api#build

# Format, lint, and type-check
vp check apps/api
```
