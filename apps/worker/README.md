# `@media-ref/worker`

Cloudflare Background Task Worker (`media-ref-worker`) providing the `scheduled` (cron) and `queue` (Cloudflare Queues consumer) entrypoints backed by PostgreSQL (`@media-ref/db`) and shared job-queue/fencing primitives (`@media-ref/core`).

## Entrypoints & Bindings

- `createBackgroundWorker(deps)` in [`src/worker.ts`](./src/worker.ts): constructs `{ scheduled, queue }` handlers with injectable `db`, `outbound`, `queue`, `handlers`, `config`, and clock (`now`) so tests can deterministically exercise lease expiration, duplicate queue delivery, and dispatch failures against real PostgreSQL 19.
- Default export in [`src/index.ts`](./src/index.ts): Cloudflare Worker `scheduled(controller, env, ctx)` and `queue(batch, env, ctx)` handlers binding `HYPERDRIVE_WRITE`, `JOBS_QUEUE`, and optional `AI`, cleaning up per-invocation `pg` pools via `ctx.waitUntil(...)`.
- Wrangler config in [`wrangler.jsonc`](./wrangler.jsonc) enables `nodejs_compat` and declares `HYPERDRIVE_WRITE`, `queues.producers`/`consumers` (`media-ref-jobs`), `triggers.crons`, and `ai`.

## Commands

```bash
# Run Background Worker pipeline tests (requires local PostgreSQL 19)
vp run @media-ref/worker#test

# Verify Cloudflare Worker bundle with Wrangler (dry run)
vp run @media-ref/worker#build

# Format, lint, and type-check
vp check apps/worker
```
