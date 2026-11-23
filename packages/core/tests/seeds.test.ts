import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  createFakeOutboundClient,
  importBangumiDataSeeds,
  importDoubanBridgeMovieSeeds,
  importDoubanMovieSeeds,
  importWikidataMovieSeeds,
  seedTmdbExportIds,
  type ExternalHttpRequest,
  type SeedAmbiguousLead,
} from "../src/index.ts";

describe("seed importers (#32)", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  async function setupDb(): Promise<TestDbHandle> {
    const handle = await createTestDb();
    handles.push(handle);
    return handle;
  }

  describe("Source 1: Wikidata movie seeds (importWikidataMovieSeeds)", () => {
    test("imports unambiguous SPARQL JSON bindings and normalized rows as seed_unconfirmed, skips invalid/ambiguous items, and is 100% idempotent without downgrading confirmed or delisted", async () => {
      const testDb = await setupDb();
      const now = new Date("2026-11-24T00:00:00.000Z");

      const sparqlPayload = {
        results: {
          bindings: [
            // Valid movie with TMDB P4947 + Douban P4529 + IMDb P345
            {
              item: { type: "uri", value: "http://www.wikidata.org/entity/Q172241" },
              tmdb: { type: "literal", value: "278" },
              douban: { type: "literal", value: "1292052" },
              imdb: { type: "literal", value: "tt0111161" },
              itemLabel: { type: "literal", value: "肖申克的救赎" },
              year: { type: "literal", value: "1994-09-23T00:00:00Z" },
            },
            // Valid movie without IMDb ID
            {
              item: { type: "uri", value: "http://www.wikidata.org/entity/Q105624" },
              P4947: { type: "literal", value: "2501" },
              P4529: { type: "literal", value: "1304102" },
              label: { type: "literal", value: "谍影重重" },
            },
            // Ambiguous multi-valued Wikidata QID (2 different Douban IDs) -> must skip both!
            {
              item: { type: "uri", value: "http://www.wikidata.org/entity/Q999001" },
              tmdb: { type: "literal", value: "550" },
              douban: { type: "literal", value: "1292000" },
            },
            {
              item: { type: "uri", value: "http://www.wikidata.org/entity/Q999001" },
              tmdb: { type: "literal", value: "550" },
              douban: { type: "literal", value: "1292001" },
            },
            // Missing Douban ID -> must skip as invalid
            {
              item: { type: "uri", value: "http://www.wikidata.org/entity/Q999002" },
              tmdb: { type: "literal", value: "603" },
            },
            // Non-numeric TMDB ID -> must skip as invalid
            {
              item: { type: "uri", value: "http://www.wikidata.org/entity/Q999003" },
              tmdb: { type: "literal", value: "tv/95479" },
              douban: { type: "literal", value: "34895145" },
            },
          ],
        },
      };

      const firstRun = await importWikidataMovieSeeds(testDb.writeDb, sparqlPayload, { now });
      expect(firstRun.source).toBe("wikidata");
      expect(firstRun.mediaCreated).toBe(2);
      expect(firstRun.associationsCreated).toBe(2);
      expect(firstRun.skippedAmbiguous).toBe(2);
      expect(firstRun.skippedInvalid).toBe(2);

      // Verify DB rows
      const mediaRows = await testDb.writeDb.selectFrom("media").selectAll().execute();
      expect(mediaRows).toHaveLength(2);
      expect(mediaRows.every((m) => m.type === "movie" && m.baseline === "tmdb")).toBe(true);

      const extRows = await testDb.writeDb
        .selectFrom("external_ids")
        .select(["media_id", "namespace", "native_id"])
        .execute();
      expect(extRows).toHaveLength(3); // tmdb:movie:278, imdb:tt0111161, tmdb:movie:2501
      expect(extRows.some((e) => e.namespace === "tmdb" && e.native_id === "movie:278")).toBe(true);
      expect(extRows.some((e) => e.namespace === "imdb" && e.native_id === "tt0111161")).toBe(true);
      expect(extRows.some((e) => e.namespace === "tmdb" && e.native_id === "movie:2501")).toBe(
        true,
      );

      const assocRows = await testDb.writeDb.selectFrom("associations").selectAll().execute();
      expect(assocRows).toHaveLength(2);
      for (const assoc of assocRows) {
        expect(assoc.namespace).toBe("douban");
        expect(assoc.status).toBe("seed_unconfirmed");
        expect(assoc.variant_id).toBeNull();
        expect(assoc.current_revision_id).not.toBeNull();
      }

      const segmentRows = await testDb.writeDb.selectFrom("segments").selectAll().execute();
      expect(segmentRows).toHaveLength(0); // whole-movie associations

      // No Evidence Gate jobs enqueued during import
      const jobs = await testDb.writeDb.selectFrom("background_jobs").selectAll().execute();
      expect(jobs).toHaveLength(0);

      // Promote first association to confirmed, and mark second as delisted
      const shawshankAssoc = assocRows.find((a) => a.native_id === "1292052")!;
      const bourneAssoc = assocRows.find((a) => a.native_id === "1304102")!;
      await testDb.writeDb
        .updateTable("associations")
        .set({ status: "confirmed" })
        .where("id", "=", shawshankAssoc.id)
        .execute();
      await testDb.writeDb
        .updateTable("associations")
        .set({ status: "delisted" })
        .where("id", "=", bourneAssoc.id)
        .execute();

      // Re-run import (including one brand new normalized row + re-importing existing two)
      const secondRun = await importWikidataMovieSeeds(
        testDb.writeDb,
        [
          { P4947: "278", P4529: "1292052", P345: "tt0111161", title: "肖申克的救赎" },
          { P4947: "2501", P4529: "1304102" },
          {
            P4947: "155",
            P4529: "1851857",
            P345: "tt0468569",
            title: "蝙蝠侠：黑暗骑士",
            year: 2008,
          },
        ],
        { now },
      );

      expect(secondRun.mediaCreated).toBe(1);
      expect(secondRun.mediaReused).toBe(2);
      expect(secondRun.associationsCreated).toBe(1);
      expect(secondRun.associationsPreservedConfirmedOrDelisted).toBe(2);

      // Confirm statuses were NEVER downgraded
      const afterSecondAssoc = await testDb.writeDb
        .selectFrom("associations")
        .selectAll()
        .execute();
      expect(afterSecondAssoc).toHaveLength(3);
      expect(afterSecondAssoc.find((a) => a.native_id === "1292052")?.status).toBe("confirmed");
      expect(afterSecondAssoc.find((a) => a.native_id === "1304102")?.status).toBe("delisted");
      expect(afterSecondAssoc.find((a) => a.native_id === "1851857")?.status).toBe(
        "seed_unconfirmed",
      );

      // Re-run third time for seed_unconfirmed idempotency: zero duplicate media/external_ids/associations/revisions
      const revCountBefore = (
        await testDb.writeDb.selectFrom("association_revisions").select("id").execute()
      ).length;
      const thirdRun = await importWikidataMovieSeeds(
        testDb.writeDb,
        [{ P4947: "155", P4529: "1851857", P345: "tt0468569" }],
        { now },
      );
      expect(thirdRun.associationsCreated).toBe(0);
      expect(thirdRun.associationsAlreadyPresent).toBe(1);
      const revCountAfter = (
        await testDb.writeDb.selectFrom("association_revisions").select("id").execute()
      ).length;
      expect(revCountAfter).toBe(revCountBefore);
    });
  });

  describe("Source 2: Douban movie seeds via IMDb-bridge (importDoubanMovieSeeds)", () => {
    test("imports strictly unambiguous movies (movie_results=1, tv_results=0), skips TV/multi-match/unmapped/invalid rows, and is idempotent", async () => {
      const testDb = await setupDb();
      const now = new Date("2026-11-24T01:00:00.000Z");

      const findResponses: Record<string, unknown> = {
        tt0111161: {
          movie_results: [
            {
              id: 278,
              title: "肖申克的救赎",
              original_title: "The Shawshank Redemption",
              release_date: "1994-09-23",
            },
          ],
          tv_results: [],
        },
        tt0903747: {
          movie_results: [],
          tv_results: [{ id: 1396, name: "Breaking Bad", first_air_date: "2008-01-20" }],
        },
        tt1111111: {
          movie_results: [
            { id: 1001, title: "Ambiguous A" },
            { id: 1002, title: "Ambiguous B" },
          ],
          tv_results: [],
        },
        tt2222222: {
          movie_results: [{ id: 1003, title: "Both Movie and TV" }],
          tv_results: [{ id: 2003, name: "Both Movie and TV" }],
        },
        tt9999999: {
          movie_results: [],
          tv_results: [],
        },
      };

      const outbound = createFakeOutboundClient({
        fetchExternal: async (req: ExternalHttpRequest) => {
          expect(req.kind).toBe("catalog");
          expect(req.namespace).toBe("tmdb");
          const parsedUrl = new URL(req.url);
          expect(parsedUrl.searchParams.get("external_source")).toBe("imdb_id");
          const match = parsedUrl.pathname.match(/\/find\/(tt\d+)$/i);
          const imdbId = match?.[1]?.toLowerCase();
          if (imdbId && imdbId in findResponses) {
            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify(findResponses[imdbId]),
              url: req.url,
            };
          }
          return {
            status: 404,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status_message: "Not found" }),
            url: req.url,
          };
        },
      });

      const records = [
        // Unambiguous movie -> IMPORT
        {
          doubanId: "1292052",
          imdbId: "TT0111161",
          title: "肖申克的救赎",
          originalTitle: "The Shawshank Redemption",
          year: 1994,
        },
        // TV series on TMDB -> SKIP (skippedNonMovie)
        {
          doubanId: "2373195",
          imdbId: "tt0903747",
          title: "绝命毒师",
        },
        // Multiple movie results -> SKIP (skippedAmbiguous)
        {
          doubanId: "3000001",
          imdbId: "tt1111111",
        },
        // Both movie and TV results -> SKIP (skippedAmbiguous)
        {
          doubanId: "3000002",
          imdbId: "tt2222222",
        },
        // Unmapped IMDb ID -> SKIP (skippedUnresolvable)
        {
          doubanId: "3000003",
          imdbId: "tt9999999",
        },
        // Missing/invalid IMDb ID -> SKIP (skippedInvalid)
        {
          doubanId: "3000004",
          imdbId: "not-an-imdb-id",
        },
      ];

      const firstRun = await importDoubanMovieSeeds(testDb.writeDb, records, outbound, { now });
      expect(firstRun.source).toBe("douban-movies");
      expect(firstRun.processed).toBe(6);
      expect(firstRun.mediaCreated).toBe(1);
      expect(firstRun.associationsCreated).toBe(1);
      expect(firstRun.skippedNonMovie).toBe(1);
      expect(firstRun.skippedAmbiguous).toBe(2);
      expect(firstRun.skippedUnresolvable).toBe(1);
      expect(firstRun.skippedInvalid).toBe(1);

      const mediaRows = await testDb.writeDb.selectFrom("media").selectAll().execute();
      expect(mediaRows).toHaveLength(1);
      expect(mediaRows[0]?.type).toBe("movie");
      expect(mediaRows[0]?.baseline).toBe("tmdb");
      expect(mediaRows[0]?.title).toBe("肖申克的救赎");

      const extRows = await testDb.writeDb
        .selectFrom("external_ids")
        .select(["namespace", "native_id"])
        .execute();
      expect(extRows).toEqual(
        expect.arrayContaining([
          { namespace: "tmdb", native_id: "movie:278" },
          { namespace: "imdb", native_id: "tt0111161" },
        ]),
      );

      const assocRows = await testDb.writeDb.selectFrom("associations").selectAll().execute();
      expect(assocRows).toHaveLength(1);
      expect(assocRows[0]?.namespace).toBe("douban");
      expect(assocRows[0]?.native_id).toBe("1292052");
      expect(assocRows[0]?.status).toBe("seed_unconfirmed");
      expect(assocRows[0]?.variant_id).toBeNull();

      // Re-run -> 100% idempotent
      const secondRun = await importDoubanMovieSeeds(testDb.writeDb, [records[0]!], outbound, {
        now,
      });
      expect(secondRun.mediaCreated).toBe(0);
      expect(secondRun.mediaReused).toBe(1);
      expect(secondRun.associationsCreated).toBe(0);
      expect(secondRun.associationsAlreadyPresent).toBe(1);
    });
  });

  describe("Source 3: bangumi-data seeds (importBangumiDataSeeds)", () => {
    test("imports movie/N and tv/N/season/S with canonical platform IDs and whole-season segments, strictly skips seasonless tv/N (never guessing season from title), reports optional leads, and is idempotent", async () => {
      const testDb = await setupDb();
      const now = new Date("2026-11-24T02:00:00.000Z");

      const outbound = createFakeOutboundClient({
        fetchExternal: async (req: ExternalHttpRequest) => {
          if (req.namespace === "bilibili" && req.url.includes("media_id=28229884")) {
            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ code: 0, result: { media: { season_id: 45574 } } }),
              url: req.url,
            };
          }
          if (req.namespace === "bilibili" && req.url.includes("media_id=28229999")) {
            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ code: 0, result: { media: { season_id: 28281 } } }),
              url: req.url,
            };
          }
          if (req.namespace === "bilibili" && req.url.includes("media_id=99999999")) {
            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ code: -404, message: "啥都木有" }),
              url: req.url,
            };
          }
          if (req.namespace === "iqiyi" && req.url.includes("/a_19rrtest01.html")) {
            return {
              status: 200,
              headers: { "content-type": "text/html" },
              body: '<html><script>window.__INITIAL__={"albumId":5328486914190101};</script></html>',
              url: req.url,
            };
          }
          return {
            status: 404,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ error: "not_found" }),
            url: req.url,
          };
        },
      });

      const recordedLeads: SeedAmbiguousLead[] = [];

      const bangumiDataPayload = {
        items: [
          // 1. Unambiguous TV season (tv/62564/season/3) with bangumi + bilibili md + qq + iqiyi + youku + mgtv + unresolvable bilibili
          {
            title: "響け！ユーフォニアム3",
            titleTranslate: { "zh-Hans": ["吹响！上低音号 第三季"] },
            type: "tv",
            lang: "ja",
            begin: "2024-04-07T08:00:00.000Z",
            sites: [
              { site: "tmdb", id: "tv/62564/season/3" },
              { site: "bangumi", id: "385641" },
              { site: "bilibili", id: "28229884" },
              { site: "qq", id: "m/mzc002007knmh3g" },
              { site: "iqiyi", id: "a_19rrtest01" },
              { site: "youku", id: "cc001f06962411de83b1" },
              { site: "mgtv", id: "510924" },
              { site: "bilibili", id: "99999999" }, // unresolvable md -> skipped cleanly
              { site: "netflix", id: "81234567" }, // unsupported site -> ignored
            ],
          },
          // 2. Unambiguous movie (movie/129)
          {
            title: "千と千尋の神隠し",
            titleTranslate: { "zh-Hans": ["千与千寻"] },
            type: "movie",
            lang: "ja",
            begin: "2001-07-20T00:00:00.000Z",
            sites: [
              { site: "tmdb", id: "movie/129" },
              { site: "bangumi", id: "311" },
              { site: "bilibili", id: "28229999" },
            ],
          },
          // 3. Seasonless TV (tv/95479) EVEN WITH "第二季" in title -> MUST NOT BE IMPORTED!
          {
            title: "呪術廻戦 第2期",
            titleTranslate: { "zh-Hans": ["咒术回战 第二季"] },
            type: "tv",
            lang: "ja",
            begin: "2023-07-06T14:56:00.000Z",
            sites: [
              { site: "tmdb", id: "tv/95479" },
              { site: "bangumi", id: "369304" },
              { site: "bilibili", id: "28229884" },
            ],
          },
          // 4. Missing tmdb site -> MUST NOT BE IMPORTED!
          {
            title: "No TMDB Entry",
            type: "tv",
            begin: "2024-01-01T00:00:00.000Z",
            sites: [{ site: "bangumi", id: "400001" }],
          },
        ],
      };

      const firstRun = await importBangumiDataSeeds(testDb.writeDb, bangumiDataPayload, {
        outbound,
        now,
        leadsReporter: (lead) => {
          recordedLeads.push(lead);
        },
      });

      expect(firstRun.source).toBe("bangumi-data");
      expect(firstRun.processed).toBe(4);
      expect(firstRun.mediaCreated).toBe(2); // tv/62564 and movie/129 ONLY (NOT tv/95479!)
      expect(firstRun.associationsCreated).toBe(8); // 6 for tv/62564/season/3 + 2 for movie/129
      expect(firstRun.skippedAmbiguous).toBe(2); // seasonless tv/95479 + no-tmdb item
      expect(firstRun.skippedUnresolvable).toBe(1); // unresolvable bilibili md99999999
      expect(firstRun.leadsRecorded).toBeGreaterThanOrEqual(2);
      expect(
        recordedLeads.some(
          (l) => l.targetExternalKey === "tmdb:tv:95479" && l.namespace === "bangumi",
        ),
      ).toBe(true);

      // Verify seasonless tv/95479 was NOT imported into media or external_ids
      const tv95479Ext = await testDb.writeDb
        .selectFrom("external_ids")
        .selectAll()
        .where("namespace", "=", "tmdb")
        .where("native_id", "=", "tv:95479")
        .execute();
      expect(tv95479Ext).toHaveLength(0);

      // Verify TV season 3 associations & segments
      const tv62564Ext = await testDb.writeDb
        .selectFrom("external_ids")
        .select("media_id")
        .where("namespace", "=", "tmdb")
        .where("native_id", "=", "tv:62564")
        .executeTakeFirstOrThrow();

      const tvAssocs = await testDb.writeDb
        .selectFrom("associations")
        .selectAll()
        .where("media_id", "=", tv62564Ext.media_id)
        .execute();
      expect(tvAssocs).toHaveLength(6);
      expect(tvAssocs.every((a) => a.status === "seed_unconfirmed")).toBe(true);

      const byNs = new Map(tvAssocs.map((a) => [a.namespace, a]));
      expect(byNs.get("bangumi")?.native_id).toBe("385641");
      expect(byNs.get("bangumi")?.variant_id).toBeNull();
      expect(byNs.get("bilibili")?.native_id).toBe("ss45574"); // resolved from md28229884!
      expect(byNs.get("bilibili")?.variant_id).not.toBeNull();
      expect(byNs.get("tencent")?.native_id).toBe("mzc002007knmh3g"); // from qq m/mzc002007knmh3g!
      expect(byNs.get("iqiyi")?.native_id).toBe("5328486914190101"); // from a_19rrtest01!
      expect(byNs.get("youku")?.native_id).toBe("cc001f06962411de83b1");
      expect(byNs.get("mgtv")?.native_id).toBe("510924");

      // Check platform variants are default "原声"
      const tvVariants = await testDb.writeDb
        .selectFrom("variants")
        .selectAll()
        .where("media_id", "=", tv62564Ext.media_id)
        .execute();
      expect(tvVariants).toHaveLength(5);
      expect(tvVariants.every((v) => v.description === "原声" && v.is_default)).toBe(true);

      // Check whole-season segments for season 3
      const tvSegments = await testDb.writeDb
        .selectFrom("segments")
        .selectAll()
        .where(
          "association_id",
          "in",
          tvAssocs.map((a) => a.id),
        )
        .execute();
      expect(tvSegments).toHaveLength(6);
      for (const seg of tvSegments) {
        expect(seg.season).toBe(3);
        expect(seg.episode_start).toBe(1);
        expect(seg.episode_end).toBeNull();
        expect(seg.target_episode_start).toBe(1);
        expect(seg.baseline).toBe("tmdb");
      }

      // Check movie/129 has whole-movie segments: []
      const movie129Ext = await testDb.writeDb
        .selectFrom("external_ids")
        .select("media_id")
        .where("namespace", "=", "tmdb")
        .where("native_id", "=", "movie:129")
        .executeTakeFirstOrThrow();
      const movieAssocs = await testDb.writeDb
        .selectFrom("associations")
        .selectAll()
        .where("media_id", "=", movie129Ext.media_id)
        .execute();
      expect(movieAssocs).toHaveLength(2);
      const movieSegs = await testDb.writeDb
        .selectFrom("segments")
        .selectAll()
        .where(
          "association_id",
          "in",
          movieAssocs.map((a) => a.id),
        )
        .execute();
      expect(movieSegs).toHaveLength(0);

      // Re-run import -> 100% idempotent (zero duplicate variants, associations, segments, revisions)
      const secondRun = await importBangumiDataSeeds(testDb.writeDb, bangumiDataPayload, {
        outbound,
        now,
      });
      expect(secondRun.mediaCreated).toBe(0);
      expect(secondRun.associationsCreated).toBe(0);
      expect(secondRun.associationsAlreadyPresent).toBe(8);

      const allSegmentsAfter = await testDb.writeDb.selectFrom("segments").select("id").execute();
      expect(allSegmentsAfter).toHaveLength(6);
      const allVariantsAfter = await testDb.writeDb.selectFrom("variants").select("id").execute();
      expect(allVariantsAfter).toHaveLength(6); // 5 on tv/62564 + 1 bilibili on movie/129
    });
  });

  describe("Source 4: douban-bridge seeds (importDoubanBridgeMovieSeeds)", () => {
    test("imports BOTH calibrated and uncalibrated movie rows, classifies via tmdb_daily_export_ids and outbound disambiguation, skips TV and soft-deleted rows, and is idempotent", async () => {
      const testDb = await setupDb();
      const now = new Date("2026-11-24T03:00:00.000Z");

      // Seed tmdb_daily_export_ids:
      // - 278: movie only
      // - 550: movie only
      // - 95479: tv only
      // - 1000: collision (exists in BOTH movie & tv exports -> must disambiguate!)
      await seedTmdbExportIds(testDb.writeDb, [
        { mediaType: "movie", tmdbId: "278", exportedDate: "2026-11-23" },
        { mediaType: "movie", tmdbId: "550", exportedDate: "2026-11-23" },
        { mediaType: "tv", tmdbId: "95479", exportedDate: "2026-11-23" },
        { mediaType: "movie", tmdbId: "1000", exportedDate: "2026-11-23" },
        { mediaType: "tv", tmdbId: "1000", exportedDate: "2026-11-23" },
      ]);

      const outbound = createFakeOutboundClient({
        fetchExternal: async (req: ExternalHttpRequest) => {
          // Collision disambiguation for tmdb_id=1000 (douban 500001 is TV via Douban rexxar)
          if (req.namespace === "douban" && req.url.endsWith("/500001")) {
            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                id: "500001",
                title: "某部剧集",
                type: "tv",
                is_tv: true,
                year: "2022",
                episodes_count: 12,
              }),
              url: req.url,
            };
          }
          // Collision disambiguation for tmdb_id=1000 (douban 500002 is movie via Douban rexxar)
          if (req.namespace === "douban" && req.url.endsWith("/500002")) {
            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                id: "500002",
                title: "某部电影",
                type: "movie",
                is_tv: false,
                year: "2021",
                episodes_count: 0,
              }),
              url: req.url,
            };
          }
          // Outbound fallback for tmdb_id=603 (not in export table -> TMDB movie 200, tv 404)
          if (req.namespace === "tmdb" && req.url.includes("/movie/603")) {
            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                id: 603,
                title: "黑客帝国",
                original_title: "The Matrix",
                release_date: "1999-03-31",
                external_ids: { imdb_id: "tt0133093" },
              }),
              url: req.url,
            };
          }
          if (req.namespace === "tmdb" && req.url.includes("/tv/603")) {
            return {
              status: 404,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ status_code: 34 }),
              url: req.url,
            };
          }
          // Outbound fallback for tmdb_id=1396 (not in export table -> TMDB movie 404, tv 200)
          if (req.namespace === "tmdb" && req.url.includes("/movie/1396")) {
            return {
              status: 404,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ status_code: 34 }),
              url: req.url,
            };
          }
          if (req.namespace === "tmdb" && req.url.includes("/tv/1396")) {
            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                id: 1396,
                name: "Breaking Bad",
                first_air_date: "2008-01-20",
              }),
              url: req.url,
            };
          }
          return {
            status: 404,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ error: "not_found" }),
            url: req.url,
          };
        },
      });

      const rows = [
        // 1. Calibrated movie (via daily export) -> IMPORT
        {
          douban_id: 1292052,
          tmdb_id: 278,
          imdb_id: "tt0111161",
          trakt_id: 2780,
          calibrated: true,
          deleted_at: null,
        },
        // 2. Uncalibrated movie (via daily export) -> MUST STILL IMPORT!
        {
          douban_id: 1292000,
          tmdb_id: 550,
          imdb_id: "tt0137523",
          trakt_id: null,
          calibrated: false,
          deleted_at: null,
        },
        // 3. TV series in export table -> MUST SKIP!
        {
          douban_id: 34895145,
          tmdb_id: 95479,
          imdb_id: "tt12343534",
          calibrated: true,
          deleted_at: null,
        },
        // 4. Colliding TMDB ID 1000 disambiguated as TV -> MUST SKIP!
        {
          douban_id: 500001,
          tmdb_id: 1000,
          calibrated: false,
          deleted_at: null,
        },
        // 5. Colliding TMDB ID 1000 disambiguated as movie -> IMPORT!
        {
          douban_id: 500002,
          tmdb_id: 1000,
          calibrated: false,
          deleted_at: null,
        },
        // 6. Movie classified via TMDB outbound fallback -> IMPORT!
        {
          douban_id: 1291843,
          tmdb_id: 603,
          calibrated: 0,
          deleted_at: null,
        },
        // 7. TV classified via TMDB outbound fallback -> MUST SKIP!
        {
          douban_id: 2373195,
          tmdb_id: 1396,
          calibrated: 1,
          deleted_at: null,
        },
        // 8. Soft-deleted movie -> MUST SKIP!
        {
          douban_id: 1292720,
          tmdb_id: 278,
          calibrated: true,
          deleted_at: 1700000000000,
        },
        // 9. Missing tmdb_id -> MUST SKIP!
        {
          douban_id: 1299999,
          tmdb_id: null,
          calibrated: false,
          deleted_at: null,
        },
      ];

      const firstRun = await importDoubanBridgeMovieSeeds(testDb.writeDb, rows, {
        outbound,
        now,
      });

      expect(firstRun.source).toBe("douban-bridge");
      expect(firstRun.processed).toBe(9);
      expect(firstRun.mediaCreated).toBe(4); // 278, 550, 1000 (movie), 603
      expect(firstRun.associationsCreated).toBe(4);
      expect(firstRun.skippedNonMovie).toBe(3); // 95479, 500001 (tv), 1396
      expect(firstRun.skippedDeleted).toBe(1);
      expect(firstRun.skippedInvalid).toBe(1);

      const mediaRows = await testDb.writeDb.selectFrom("media").selectAll().execute();
      expect(mediaRows).toHaveLength(4);
      expect(mediaRows.every((m) => m.type === "movie" && m.baseline === "tmdb")).toBe(true);

      const assocs = await testDb.writeDb.selectFrom("associations").selectAll().execute();
      expect(assocs).toHaveLength(4);
      expect(assocs.every((a) => a.namespace === "douban" && a.status === "seed_unconfirmed")).toBe(
        true,
      );
      expect(assocs.map((a) => a.native_id).toSorted()).toEqual([
        "1291843",
        "1292000",
        "1292052",
        "500002",
      ]);

      // Verify trakt external ID was attached for movie:278
      const traktExt = await testDb.writeDb
        .selectFrom("external_ids")
        .selectAll()
        .where("namespace", "=", "trakt")
        .where("native_id", "=", "movie:2780")
        .execute();
      expect(traktExt).toHaveLength(1);

      // Re-run -> 100% idempotent
      const secondRun = await importDoubanBridgeMovieSeeds(testDb.writeDb, rows, {
        outbound,
        now,
      });
      expect(secondRun.mediaCreated).toBe(0);
      expect(secondRun.associationsCreated).toBe(0);
      expect(secondRun.associationsAlreadyPresent).toBe(4);
    });
  });

  describe("Seed CLI helper (seed-cli.ts)", () => {
    test("parses CLI arguments and NDJSON/JSON payloads cleanly", async () => {
      const cli = await import("../src/seed-cli.ts");
      const parsed = cli.parseSeedCliArgs([
        "--source",
        "wikidata",
        "--file",
        "/tmp/wikidata.json",
        "--no-outbound",
      ]);
      expect(parsed.kind).toBe("run");
      if (parsed.kind === "run") {
        expect(parsed.source).toBe("wikidata");
        expect(parsed.file).toBe("/tmp/wikidata.json");
        expect(parsed.noOutbound).toBe(true);
      }

      const ndjson = cli.parseSeedFileText(
        '{"douban_id":1292052,"tmdb_id":278}\n{"douban_id":1292000,"tmdb_id":550}\n',
      );
      expect(Array.isArray(ndjson)).toBe(true);
      expect(ndjson).toHaveLength(2);
    });
  });
});
