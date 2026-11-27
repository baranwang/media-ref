Background (from the session that started this one):
Context: a read-only audit of the `media-ref` monorepo at commit `b7b6683` produced a vetted list of findings, and the maintainer asked for them to be fixed in parallel, one category per session. You own one category. Eight sessions run at once in separate git worktrees, so staying inside your file scope is what keeps the branches mergeable. An advisor session reviews your diff afterwards; you push and merge nothing.

Project: an open database mapping media (movies, TV) to collection and entry IDs across video platforms and catalog sites. Bun workspaces (`apps/api`, `apps/worker`, `apps/website`, `packages/core`, `packages/db`, `packages/client`, `packages/ui`), TypeScript, Vite+ toolchain, Cloudflare Workers, PostgreSQL via Kysely, ConnectRPC.

Governing docs, read before designing: `CONSTITUTION.md` (no human intervenes at runtime; every flow ends automatically: a change request ends approved or rejected, a demand ends fulfilled, not found or retry later; when unsure, do not write; outside input is evidence, never a decision), `GLOSSARY.md` (use its vocabulary in names and comments), `docs/adr/0001` to `0003` (ADR 0003's two 2026-11-27 amendments supersede its body).

Setup and commands:
- Line numbers in the brief are as of `b7b6683`; confirm them against the code before editing.
- Run `bun install` first. It rewrites one line of `bun.lock` (the `@media-ref/client` version); do not commit `bun.lock` unless your brief says you own it.
- `vp` is not on PATH: use `node_modules/.bin/vp`.
- Tests: `node_modules/.bin/vp run -r test`. Baseline: all green, 441 passed, 38 skipped (the skipped ones are `review-agent.eval.test.ts`, which needs a live model; leave it skipped). API, worker, core and db tests use the local PostgreSQL container on `127.0.0.1:54329`, already running; each test file creates its own ephemeral database. If tests cannot connect, stop and report; do not start or stop Docker.
- Format, lint, typecheck: `node_modules/.bin/vp check <directories you changed>`. A root-level `vp check` fails at baseline only on `packages/client/CHANGELOG.md` formatting (another session fixes it).
- Tests run against real PostgreSQL through `createTestDb()` from `@media-ref/db/testing`, with `createFakeOutboundClient()` from `@media-ref/core` as the only test double; follow the existing test files named in your brief.
- Code style: match the surrounding code, comment only the why, no new dependencies, nothing beyond what the fix needs. If you must export something new from `packages/core/src/index.ts`, add a single line next to the related exports.
- Git: commit on your worktree branch with conventional commits (repo example: `fix(core): media known only from Douban or Bangumi get their TMDB ID looked up`). Do not push, do not open a PR, do not touch other branches.
- Step 0: save your brief verbatim as the `plans/NNN-<slug>.md` file it names and include it in your first commit.
- Never copy secret or key values into code comments, tests, commit messages or reports.

Stop and report instead of improvising when: the code at a cited location does not match the description; a correct fix needs a file outside your scope; a verification step fails twice after a reasonable fix attempt.

Final report in Simplified Chinese: what changed per file, test and check results, and everything you did not do or could not verify.

Task:
Plan file to save in step 0: `plans/001-website-link-parsing.md`.

## The bug
The website's contribute drawer sends an ID the API rejects for iQiyi links and Youku `/v_show/` links. Found by reading code; nobody has sent a real request, so reproduce it in a test first.

- `apps/website/src/components/contribute-drawer.tsx`, about lines 212-219: the submit mutation calls `createChangeRequest` with `nativeId: parsed.nativeId` and `rawNativeId: parsed.url`, where `parsed = parseExternalInput(urlInput)`.
- `apps/website/src/lib/url-parser.ts`, about lines 155-165: for an iqiyi.com URL the parser matches `/(a|v)_([a-z0-9]+)\.html` and returns only the slug as `nativeId`, dropping the `a_` / `v_` prefix.
- Same file, about lines 167-179: for youku.com it returns the id captured from `/v_show/id_<id>.html` or `/show/id_<id>.html`.
- Server: `packages/core/src/media-service.ts`, about lines 632-648: `createChangeRequest` calls `adapter.parseInput(trimmedNativeId)` on the `nativeId` field (not on `rawNativeId`) and throws `INVALID_NATIVE_ID` when it returns null.
- `packages/core/src/adapters/iqiyi.ts`, `parseIqiyiInput` at about line 429, patterns at lines 62-67: accepts only a bare numeric id of 6+ digits, `a_<slug>`, `v_<slug>`, or a full http(s) URL on `iqiyi.com`, `www.iqiyi.com` or `m.iqiyi.com`. A bare slug such as `19rrfe142o` matches none, so it returns null.
- `packages/core/src/adapters/youku.ts`, `parseYoukuInput` at about line 218, patterns at lines 40-44: a bare id is accepted only as 20 hex characters with an optional leading `z` (a show id); a `/v_show/` video id is accepted only inside a full URL. This file holds an API client id near line 47: do not copy it anywhere.
- The only website parser test, `apps/website/tests/url-parser.test.ts` (17 lines), asserts `.url` and never `.nativeId`, so it cannot see this.
- Related, verify and fix if true: `buildExternalUrl("youku", id)` in `url-parser.ts` (about line 34) always builds a `/v_show/id_<id>.html` URL, but the canonical Youku id the server stores is the 20-hex show id, whose page shape per the adapter's own URL pattern is `/show/id_z<id>.html`.

## What must be true when you are done
1. For every link shape `parseExternalInput` accepts, the value the drawer sends as `nativeId` is accepted by the matching server adapter's parse function in `packages/core/src/adapters` (`parseBilibiliInput`, `parseTencentInput`, `parseIqiyiInput`, `parseYoukuInput`, `parseMgtvInput`, and the Douban and Bangumi adapters). Read each adapter's accepted forms and fix the website side to match. Do not loosen the server parsers.
2. Display keeps working. Other consumers of the parse result: `apps/website/src/components/search-box.tsx` (about line 44), `apps/website/src/routes/media.$mediaId.tsx` (about line 155), `apps/website/src/lib/mappers.ts` (about line 550, `buildExternalUrl`) and the drawer's own preview. Stored canonical ids (numeric for iQiyi) must still build the right page URL: the existing cases in `url-parser.test.ts` must keep passing unchanged.
3. `apps/website/tests/url-parser.test.ts` gains a table-driven test with at least one real-shaped URL per platform and catalog the parser supports (bilibili ss/ep/md, tencent cover and detail, iqiyi `a_` and `v_`, youku `v_show` and `show`, mgtv, douban, tmdb, imdb, tvdb, trakt, bangumi), asserting `namespace`, `nativeId` and `url`. The iQiyi and Youku expectations must be forms the server patterns above accept.
4. Preferred: match hosts by suffix (`host === "iqiyi.com" || host.endsWith(".iqiyi.com")`) instead of `host.includes(...)`, so a look-alike host is not shown as a recognised platform link.

## Scope
In scope: `apps/website/src/lib/url-parser.ts`, `apps/website/src/components/contribute-drawer.tsx`, `apps/website/tests/url-parser.test.ts`, the plan file.
Out of scope: everything under `packages/` and `apps/api`, and every other website file.

## Verify
- `node_modules/.bin/vp run @media-ref/website#test` passes, including the new table test.
- `node_modules/.bin/vp check apps/website` exits 0.
- `git status` shows only in-scope files changed (`bun.lock` modified but uncommitted is expected).

## Extra stop condition
An adapter accepts no form the website can produce from the pasted link without a network call.

## Report additionally
The exact `nativeId` now sent for an iQiyi `a_` link, an iQiyi `v_` link, a Youku `v_show` link and a Youku `show` link.
