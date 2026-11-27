# `@media-ref/worker`

Cloudflare Background Task Worker (`media-ref-worker`) providing the `scheduled` (cron) and `queue` (Cloudflare Queues consumer) entrypoints backed by PostgreSQL (`@media-ref/db`) and shared job-queue/fencing primitives (`@media-ref/core`).

## Entrypoints & Bindings

- `createBackgroundWorker(deps)` in [`src/worker.ts`](./src/worker.ts): constructs `{ scheduled, queue }` handlers with injectable `db`, `outbound`, `queue`, `handlers`, `config`, and clock (`now`) so tests can deterministically exercise lease expiration, duplicate queue delivery, and dispatch failures against real PostgreSQL 19.
- Default export in [`src/index.ts`](./src/index.ts): Cloudflare Worker `scheduled(controller, env, ctx)` and `queue(batch, env, ctx)` handlers binding `HYPERDRIVE_WRITE`, `JOBS_QUEUE`, and optional `AI`, cleaning up per-invocation `pg` pools via `ctx.waitUntil(...)`.
- Wrangler config in [`wrangler.jsonc`](./wrangler.jsonc) enables `nodejs_compat` and declares `HYPERDRIVE_WRITE`, `queues.producers`/`consumers` (`media-ref-jobs`), `triggers.crons`, and `ai`.

## Environment

For local overrides, copy the entries you need from [`.dev.vars.example`](./.dev.vars.example) into `.dev.vars`. Configure resource bindings in [`wrangler.jsonc`](./wrangler.jsonc). The production column describes the checked-in Wrangler configuration.

| Settings or bindings                                                                                                                                        | Required for                     | Code default and production configuration                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `HYPERDRIVE_WRITE`, `JOBS_QUEUE`                                                                                                                            | Background processing            | Production binds the database and queue.                                                                       |
| `MAGPIE_GATEWAY_KEY`, `HK`                                                                                                                                  | Magpie model calls and web tools | Magpie uses the `HK` binding when the key is configured.                                                       |
| `AI`, `AI_GATEWAY_ID`                                                                                                                                       | Cloudflare model calls           | Production binds Workers AI and configures gateway `gateway`.                                                  |
| `AI_PROVIDER`, `AI_MODEL`                                                                                                                                   | Optional                         | Defaults are `workers-ai` and `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Production uses `group/cheap-first`. |
| `TOKENS_API_TOKEN`                                                                                                                                          | Optional                         | Enables usage reporting to tokens.ci.                                                                          |
| `OUTBOUND_PROXY_CONFIG`                                                                                                                                     | Optional                         | Direct by default. Production routes Bilibili and Youku through `HK`.                                          |
| `TMDB_ACCESS_TOKEN`, `TMDB_API_KEY`, `TVDB_BEARER_TOKEN`, `TRAKT_CLIENT_ID`                                                                                 | Authenticated catalog requests   | TMDB prefers the bearer token over the API key. TVDB and Trakt use their own credentials.                      |
| `TMDB_API_BASE_URL`, `TVDB_API_BASE_URL`, `DOUBAN_API_BASE_URL`, `BANGUMI_API_BASE_URL`, `IMDB_API_BASE_URL`, `TRAKT_API_BASE_URL`, `TMDB_EXPORTS_BASE_URL` | Optional                         | Use built-in upstream endpoints by default.                                                                    |
| `ENABLE_DAILY_TMDB_EXPORTS_SYNC`                                                                                                                            | Optional                         | Enabled by default. Production sets `false` to disable daily exports.                                          |
| `JOB_BATCH_SIZE`, `JOB_LEASE_DURATION_MS`                                                                                                                   | Optional                         | Default batch size 20, lease 300,000 ms.                                                                       |
| `EXPLORATION_DAILY_BUDGET`, `EXPLORATION_BATCH_SIZE`                                                                                                        | Optional                         | Defaults are 100 demands per UTC day and 10 per batch. Production uses 2000 and 5.                             |
| `EXPLORATION_LEASE_DURATION_MS`, `EXPLORATION_BACKOFF_SECONDS`                                                                                              | Optional                         | Default lease 900,000 ms, retry delays 1, 3, 7 and 30 days.                                                    |
| `EXPLORATION_MAX_STEPS`, `EXPLORATION_MAX_DURATION_MS`, `EXPLORATION_MAX_TASK_TOKENS`, `EXPLORATION_DAILY_TOKEN_BUDGET`                                     | Optional                         | Defaults are 64 steps, 300,000 ms and 2,000,000 tokens per task, with 1,000,000,000 tokens per UTC day.        |
| `REVIEW_AGENT_DAILY_BUDGET`                                                                                                                                 | Optional                         | Defaults to 0 model reviews per UTC day. Production allows 200.                                                |
| `REVIEW_AGENT_MAX_STEPS`, `REVIEW_AGENT_MAX_DURATION_MS`, `REVIEW_AGENT_MAX_TASK_TOKENS`                                                                    | Optional                         | Defaults are 16 steps, 180,000 ms and 300,000 tokens per review.                                               |

## Commands

```bash
# Run Background Worker pipeline tests (requires local PostgreSQL 19)
vp run @media-ref/worker#test

# Verify Cloudflare Worker bundle with Wrangler (dry run)
vp run @media-ref/worker#build

# Format, lint, and type-check
vp check apps/worker
```
