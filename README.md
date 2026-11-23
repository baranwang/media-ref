# media-ref

An open database mapping media (movies and TV series) to their collection and entry IDs across video platforms and catalog sites, down to season and episode segments.

Domain terminology is defined in [`GLOSSARY.md`](./GLOSSARY.md).

## Workspace Layout

- `apps/api` (`@media-ref/api`): Hono API Cloudflare Worker (`api.mediaref.org`).
- `apps/website` (`@media-ref/website`): TanStack Start SSR web app (`mediaref.org`).
- `packages/db` (`@media-ref/db`): Kysely database types, PostgreSQL connection factory, TypeScript migrations, and ephemeral test DB helper.
- `packages/core` (`@media-ref/core`): Shared core services and the outbound call layer (`OutboundClient`).
- `packages/ui` (`@media-ref/ui`): Shared UI components.

## Prerequisites

- [Bun](https://bun.sh/) (see `devEngines` in `package.json`)
- [Docker](https://www.docker.com/) (for local PostgreSQL 19)

Install dependencies:

```bash
bun install
```

## Local PostgreSQL 19

Start the local PostgreSQL 19 container (bound to `127.0.0.1:54329`, database `media_ref_dev`, user/password `postgres`/`postgres`):

```bash
docker compose up -d
```

Stop the container:

```bash
docker compose down
```

## Database Migrations

Run Kysely TypeScript migrations against the local development database:

```bash
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/media_ref_dev vpx packages/db/src/migrate.ts
```

Or via the workspace task:

```bash
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/media_ref_dev vp run db:migrate
```

## Running Tests

Make sure local PostgreSQL 19 is running (`docker compose up -d`). Database and API Worker tests automatically create and migrate an isolated ephemeral database (`media_ref_test_<hex>`) on `TEST_DATABASE_URL` (defaulting to `postgres://postgres:postgres@127.0.0.1:54329/postgres`) and drop it during cleanup.

```bash
# Run tests across all workspace packages
vp run -r test

# Run tests for a single package
vp run @media-ref/db#test
vp run @media-ref/core#test
vp run @media-ref/api#test
```

To point tests at a different PostgreSQL admin URL:

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/postgres vp run -r test
```

## Formatting, Linting, Type-Checking, and Dev Servers

```bash
# Format, lint, and type-check
vp check

# Build all packages/apps
vp run -r build

# Start website dev server (port 3000)
vp run dev

# Start API Worker locally with Wrangler
vp run @media-ref/api#dev
```
