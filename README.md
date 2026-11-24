# media-ref

An open database mapping media (movies and TV series) to their collection and entry IDs across video platforms and catalog sites, down to season and episode segments.

Domain terminology is defined in [`GLOSSARY.md`](./GLOSSARY.md).

## Workspace Layout

- `proto/mediaref/v1/`: Canonical Protobuf v3 API schemas (single source of truth for all business RPCs, including the structured `MediaRef` `oneof`, generated into `packages/client/src/gen` via Buf).
- `apps/api` (`@media-ref/api`): ConnectRPC Protobuf Cloudflare Worker (`api.mediaref.org`) built directly on Web Fetch API (`@connectrpc/connect` + Better Auth + Kysely).
- `apps/worker` (`@media-ref/worker`): Background Cloudflare Worker (Queues & Cron) for evidence gate checks, exploration agent loops, and TMDB daily sync.
- `apps/website` (`@media-ref/website`): TanStack Start SSR web app (`mediaref.org`, scaffold wired to `@media-ref/ui`).
- `packages/client` (`@media-ref/client`): TypeScript SDK (`@connectrpc/connect-web` + `@bufbuild/protobuf`), generated Protobuf descriptors, and pure episode-resolution / segment-validation utilities.
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

## Protobuf & ConnectRPC Codegen

All business APIs are defined under [`proto/mediaref/v1/`](./proto/mediaref/v1/) (`MediaService`, `ChangeRequestService`, `AssociationService`, `AccountService`, `ReviewerService`) and served over ConnectRPC (binary Protobuf by default, with Connect JSON and gRPC-Web interoperability). Better Auth (`/api/auth/*`) and health probes (`/health`) remain standard HTTP/JSON.

```bash
# Lint .proto schemas with Buf
vp run proto:lint

# Regenerate TypeScript Protobuf-ES & ConnectRPC descriptors into packages/client/src/gen
vp run proto:gen
```

## Local PostgreSQL 19

Start the local PostgreSQL 19 container (defined in [`packages/db/compose.yaml`](./packages/db/compose.yaml), bound to `127.0.0.1:54329`, database `media_ref_dev`, user/password `postgres`/`postgres`):

```bash
vp run db:up
# or: docker compose -f packages/db/compose.yaml up -d
```

Stop the container:

```bash
vp run db:down
# or: docker compose -f packages/db/compose.yaml down
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

Make sure local PostgreSQL 19 is running (`vp run db:up`). Database, core, API Worker, and background Worker tests automatically create and migrate an isolated ephemeral database (`media_ref_test_<hex>`) on `TEST_DATABASE_URL` (defaulting to `postgres://postgres:postgres@127.0.0.1:54329/postgres`) and drop it during cleanup.

```bash
# Run tests across all workspace packages
vp run -r test

# Run tests for a single package
vp run @media-ref/client#test
vp run @media-ref/db#test
vp run @media-ref/core#test
vp run @media-ref/api#test
vp run @media-ref/worker#test
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
