import { sql } from "kysely";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { runMigrations } from "../src/index.ts";
import { createTestDb, type TestDbHandle } from "../src/testing.ts";

describe("packages/db migrations", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  test("runs all migrations from scratch on an empty PostgreSQL 19 database", async () => {
    const testDb = await createTestDb({ migrate: false });
    handles.push(testDb);

    const results = await runMigrations(testDb.writeDb);

    expect(results).toEqual([
      {
        migrationName: "0001_initial",
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: "0002_auth",
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: "0003_background_jobs",
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: "0004_api_keys",
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: "0005_media_domain",
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: "0006_leads",
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: "0007_platform_status",
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: "0008_reputation_rate_limits",
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: "0009_sync_state",
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: "0010_demands",
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: "0011_invalidation_reports",
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: "0012_exploration_budget",
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: "0013_unified_associations",
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: "0014_demand_review",
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: "0015_agent_external_ids",
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: "0016_exploration_token_budget",
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: "0017_review_agent_budget",
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: "0018_lead_segments",
        direction: "Up",
        status: "Success",
      },
    ]);

    const row = await testDb.readDb
      .selectFrom("schema_meta")
      .select(["key", "value"])
      .where("key", "=", "bootstrap_version")
      .executeTakeFirst();

    expect(row).toEqual({
      key: "bootstrap_version",
      value: "0001_initial",
    });

    const now = new Date();
    await testDb.writeDb
      .insertInto("user")
      .values({
        id: "user_1",
        name: "Test Developer",
        email: "dev@mediaref.org",
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      })
      .execute();

    await testDb.writeDb
      .insertInto("session")
      .values({
        id: "sess_1",
        userId: "user_1",
        token: "tok_1",
        expiresAt: new Date(now.getTime() + 60_000),
        createdAt: now,
        updatedAt: now,
      })
      .execute();

    await testDb.writeDb
      .insertInto("account")
      .values({
        id: "acc_1",
        userId: "user_1",
        accountId: "user_1",
        providerId: "credential",
        password: "hashed-password",
        createdAt: now,
        updatedAt: now,
      })
      .execute();

    await testDb.writeDb
      .insertInto("verification")
      .values({
        id: "ver_1",
        identifier: "dev@mediaref.org",
        value: "token-value",
        expiresAt: new Date(now.getTime() + 60_000),
        createdAt: now,
        updatedAt: now,
      })
      .execute();

    await testDb.writeDb
      .insertInto("apikey")
      .values({
        id: "key_1",
        configId: "default",
        name: "CLI Key",
        start: "mref_abcdef",
        referenceId: "user_1",
        prefix: "mref_",
        key: "hashed-key-digest",
        enabled: true,
        rateLimitEnabled: false,
        requestCount: 0,
        expiresAt: null,
        createdAt: now,
        updatedAt: now,
        permissions: JSON.stringify({ media: ["read", "report"] }),
      })
      .execute();

    const apiKeyRow = await testDb.readDb
      .selectFrom("apikey")
      .select(["id", "configId", "referenceId", "key", "enabled", "permissions"])
      .where("key", "=", "hashed-key-digest")
      .executeTakeFirst();

    expect(apiKeyRow).toEqual({
      id: "key_1",
      configId: "default",
      referenceId: "user_1",
      key: "hashed-key-digest",
      enabled: true,
      permissions: JSON.stringify({ media: ["read", "report"] }),
    });

    const userRow = await testDb.readDb
      .selectFrom("user")
      .select(["id", "email", "emailVerified", "role", "reputation"])
      .where("id", "=", "user_1")
      .executeTakeFirst();

    expect(userRow).toEqual({
      id: "user_1",
      email: "dev@mediaref.org",
      emailVerified: false,
      role: "user",
      reputation: 0,
    });

    const insertedJob = await testDb.writeDb
      .insertInto("background_jobs")
      .values({
        job_type: "echo",
        dedupe_key: "test:unique",
        status: "pending",
        payload: JSON.stringify({ hello: "world" }),
      })
      .returning([
        "id",
        "job_type",
        "status",
        "priority",
        "attempts",
        "max_attempts",
        "lease_generation",
      ])
      .executeTakeFirstOrThrow();

    expect(insertedJob).toMatchObject({
      job_type: "echo",
      status: "pending",
      priority: 0,
      attempts: 0,
      max_attempts: 5,
      lease_generation: 0,
    });

    // Active dedupe_key prevents duplicate active jobs
    await expect(
      testDb.writeDb
        .insertInto("background_jobs")
        .values({
          job_type: "echo",
          dedupe_key: "test:unique",
          status: "pending",
        })
        .execute(),
    ).rejects.toThrow();

    // Completing the job frees the partial unique index for future re-scheduling
    await testDb.writeDb
      .updateTable("background_jobs")
      .set({ status: "completed", completed_at: new Date() })
      .where("id", "=", insertedJob.id)
      .execute();

    const rescheduled = await testDb.writeDb
      .insertInto("background_jobs")
      .values({
        job_type: "echo",
        dedupe_key: "test:unique",
        status: "pending",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    expect(rescheduled.id).not.toBe(insertedJob.id);

    // Media domain tables from 0005_media_domain
    const insertedMedia = await testDb.writeDb
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "tmdb",
        title: "咒术回战",
        original_title: "呪術廻戦",
        year: 2020,
        seasons: JSON.stringify([{ season: 1, episodeCount: 47, airYear: 2020 }]),
      })
      .returning(["id", "type", "baseline", "title"])
      .executeTakeFirstOrThrow();

    expect(insertedMedia).toMatchObject({
      type: "tv",
      baseline: "tmdb",
      title: "咒术回战",
    });

    // External IDs are whole-media associations on authority catalogs (0013_unified_associations)
    await testDb.writeDb
      .insertInto("associations")
      .values({
        media_id: insertedMedia.id,
        namespace: "tmdb",
        native_id: "tv:95479",
        status: "confirmed",
        is_external_id: true,
        source: "sync",
      })
      .execute();

    // Unique (namespace, native_id) rejects duplicate external IDs
    await expect(
      testDb.writeDb
        .insertInto("associations")
        .values({
          media_id: insertedMedia.id,
          namespace: "tmdb",
          native_id: "tv:95479",
          status: "confirmed",
          is_external_id: true,
          source: "sync",
        })
        .execute(),
    ).rejects.toThrow();

    // IMDb season/episode entries coexist with the show's External ID
    await testDb.writeDb
      .insertInto("associations")
      .values([
        {
          media_id: insertedMedia.id,
          namespace: "imdb",
          native_id: "tt12343534",
          status: "confirmed",
          is_external_id: true,
          source: "sync",
        },
        {
          media_id: insertedMedia.id,
          namespace: "imdb",
          native_id: "tt13624322",
          status: "confirmed",
          title: "Episode #1.1",
          episode_count: 1,
        },
      ])
      .execute();

    // Namespace registry: unknown namespaces and platform rows without a variant are rejected
    await expect(
      testDb.writeDb
        .insertInto("associations")
        .values({
          media_id: insertedMedia.id,
          namespace: "unknown_ns" as never,
          native_id: "1",
          status: "confirmed",
        })
        .execute(),
    ).rejects.toThrow();
    await expect(
      testDb.writeDb
        .insertInto("associations")
        .values({
          media_id: insertedMedia.id,
          namespace: "bilibili",
          native_id: "ss-without-variant",
          status: "confirmed",
        })
        .execute(),
    ).rejects.toThrow();

    const defaultVariant = await testDb.writeDb
      .insertInto("variants")
      .values({
        media_id: insertedMedia.id,
        platform: "bilibili",
        description: "原声",
        is_default: true,
      })
      .returning(["id", "is_default"])
      .executeTakeFirstOrThrow();

    expect(defaultVariant.is_default).toBe(true);

    // Partial unique index prevents two default variants for the same (media_id, platform)
    await expect(
      testDb.writeDb
        .insertInto("variants")
        .values({
          media_id: insertedMedia.id,
          platform: "bilibili",
          description: "中配",
          is_default: true,
        })
        .execute(),
    ).rejects.toThrow();

    // Non-default variant for the same (media_id, platform) succeeds
    await testDb.writeDb
      .insertInto("variants")
      .values({
        media_id: insertedMedia.id,
        platform: "bilibili",
        description: "中配",
        is_default: false,
      })
      .execute();

    const assoc = await testDb.writeDb
      .insertInto("associations")
      .values({
        media_id: insertedMedia.id,
        namespace: "bilibili",
        native_id: "ss34430",
        variant_id: defaultVariant.id,
        status: "confirmed",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const rev = await testDb.writeDb
      .insertInto("association_revisions")
      .values({
        association_id: assoc.id,
        revision_number: 1,
        variant_id: defaultVariant.id,
        status: "confirmed",
        segments: JSON.stringify([
          { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" },
        ]),
        actor_user_id: "user_1",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await testDb.writeDb
      .updateTable("associations")
      .set({ current_revision_id: rev.id })
      .where("id", "=", assoc.id)
      .execute();

    await testDb.writeDb
      .insertInto("segments")
      .values({
        association_id: assoc.id,
        season: 1,
        episode_start: 1,
        episode_end: 24,
        target_episode_start: 1,
        baseline: "tmdb",
      })
      .execute();

    const cr = await testDb.writeDb
      .insertInto("change_requests")
      .values({
        status: "needs_review",
        submitter_user_id: "user_1",
        media_id: insertedMedia.id,
        target_external_key: "tmdb:tv:95479",
        namespace: "bilibili",
        raw_native_id: "ss45574",
        native_id: "ss45574",
        variant_id: defaultVariant.id,
        segments: JSON.stringify([
          { season: 1, episodeStart: 25, episodeEnd: 47, targetEpisodeStart: 1, baseline: "tmdb" },
        ]),
      })
      .returning(["id", "status", "submitter_type"])
      .executeTakeFirstOrThrow();

    expect(cr).toMatchObject({
      status: "needs_review",
      submitter_type: "human",
    });

    const submitterCreatedIdx = await sql<{ indexdef: string }>`
      select indexdef
      from pg_indexes
      where schemaname = 'public'
        and tablename = 'change_requests'
        and indexname = 'change_requests_submitter_created_idx'
    `.execute(testDb.readDb);

    expect(submitterCreatedIdx.rows).toHaveLength(1);
    expect(submitterCreatedIdx.rows[0]?.indexdef).toMatch(/submitter_user_id,\s*created_at DESC/i);

    const insertedLead = await testDb.writeDb
      .insertInto("leads")
      .values({
        target_external_key: "tmdb:tv:95479",
        namespace: "bilibili",
        native_id: "ss34430",
        season: 1,
        variant_description: "原声",
        notes: "Reported from client player",
        reporter_user_id: "user_1",
        reporter_key_id: "key_1",
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(insertedLead).toMatchObject({
      target_external_key: "tmdb:tv:95479",
      namespace: "bilibili",
      native_id: "ss34430",
      season: 1,
      variant_description: "原声",
      notes: "Reported from client player",
      reporter_user_id: "user_1",
      reporter_key_id: "key_1",
    });
    expect(insertedLead.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(insertedLead.created_at).toBeInstanceOf(Date);

    // Rejects negative season and unknown reporter_user_id at the DB constraint level
    await expect(
      testDb.writeDb
        .insertInto("leads")
        .values({
          target_external_key: "tmdb:tv:95479",
          namespace: "bilibili",
          native_id: "ss34430",
          season: -1,
          reporter_user_id: "user_1",
          reporter_key_id: "key_1",
        })
        .execute(),
    ).rejects.toThrow();

    await expect(
      testDb.writeDb
        .insertInto("leads")
        .values({
          target_external_key: "tmdb:tv:95479",
          namespace: "bilibili",
          native_id: "ss34430",
          reporter_user_id: "nonexistent_user",
          reporter_key_id: "key_1",
        })
        .execute(),
    ).rejects.toThrow();

    // Platform checks table from 0007_platform_status
    const checkedAt = new Date("2026-11-20T12:00:00.000Z");
    const nextRetryAt = new Date("2026-11-27T12:00:00.000Z");
    const insertedCheck = await testDb.writeDb
      .insertInto("platform_checks")
      .values({
        media_id: insertedMedia.id,
        platform: "iqiyi",
        status: "not_found",
        checked_at: checkedAt,
        next_retry_at: nextRetryAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(insertedCheck).toMatchObject({
      media_id: insertedMedia.id,
      platform: "iqiyi",
      status: "not_found",
      attempt_count: 1,
    });
    expect(insertedCheck.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(insertedCheck.checked_at.toISOString()).toBe(checkedAt.toISOString());
    expect(insertedCheck.next_retry_at?.toISOString()).toBe(nextRetryAt.toISOString());

    // Unique (media_id, platform) prevents duplicate check rows for the same platform
    await expect(
      testDb.writeDb
        .insertInto("platform_checks")
        .values({
          media_id: insertedMedia.id,
          platform: "iqiyi",
          status: "not_found",
          checked_at: checkedAt,
        })
        .execute(),
    ).rejects.toThrow();

    // Rejects invalid platform, invalid status, and attempt_count < 1
    await expect(
      testDb.writeDb
        .insertInto("platform_checks")
        .values({
          media_id: insertedMedia.id,
          platform: "douban" as any,
          status: "not_found",
          checked_at: checkedAt,
        })
        .execute(),
    ).rejects.toThrow();

    await expect(
      testDb.writeDb
        .insertInto("platform_checks")
        .values({
          media_id: insertedMedia.id,
          platform: "youku",
          status: "associated" as any,
          checked_at: checkedAt,
        })
        .execute(),
    ).rejects.toThrow();

    await expect(
      testDb.writeDb
        .insertInto("platform_checks")
        .values({
          media_id: insertedMedia.id,
          platform: "youku",
          status: "not_found",
          checked_at: checkedAt,
          attempt_count: 0,
        })
        .execute(),
    ).rejects.toThrow();

    // Sync state and review alerts tables from 0009_sync_state
    const insertedSync = await testDb.writeDb
      .insertInto("sync_state")
      .values({
        sync_key: "tmdb_changes_tv",
        last_synced_date: "2026-11-23",
        metadata: JSON.stringify({ mode: "changes", refreshedCount: 1 }),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(insertedSync).toMatchObject({
      sync_key: "tmdb_changes_tv",
      last_synced_date: "2026-11-23",
    });
    expect(insertedSync.updated_at).toBeInstanceOf(Date);

    // Rejects malformed last_synced_date
    await expect(
      testDb.writeDb
        .insertInto("sync_state")
        .values({
          sync_key: "tmdb_changes_bad",
          last_synced_date: "2026/11/23",
        })
        .execute(),
    ).rejects.toThrow();

    const insertedAlert = await testDb.writeDb
      .insertInto("review_alerts")
      .values({
        alert_type: "tmdb_missing_or_merged",
        media_id: insertedMedia.id,
        association_id: assoc.id,
        details: JSON.stringify({ tmdbExternalKey: "tmdb:tv:95479" }),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(insertedAlert).toMatchObject({
      alert_type: "tmdb_missing_or_merged",
      media_id: insertedMedia.id,
      association_id: assoc.id,
      status: "open",
      resolved_at: null,
      resolved_by_user_id: null,
    });
    expect(insertedAlert.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(insertedAlert.created_at).toBeInstanceOf(Date);

    // Rejects invalid review_alerts status
    await expect(
      testDb.writeDb
        .insertInto("review_alerts")
        .values({
          alert_type: "tmdb_missing_or_merged",
          media_id: insertedMedia.id,
          status: "invalid_status" as "open",
        })
        .execute(),
    ).rejects.toThrow();

    // Demands table from 0010_demands
    const insertedMediaDemand = await testDb.writeDb
      .insertInto("demands")
      .values({
        media_id: insertedMedia.id,
        season: 2,
        namespace_group: "platform",
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(insertedMediaDemand).toMatchObject({
      media_id: insertedMedia.id,
      external_key: null,
      season: 2,
      namespace_group: "platform",
      demand_count: 1,
      status: "open",
      not_found_count: 0,
      lease_generation: 0,
      last_explored_at: null,
      lease_expires_at: null,
    });
    expect(insertedMediaDemand.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(insertedMediaDemand.next_eligible_at).toBeInstanceOf(Date);
    expect(insertedMediaDemand.last_demanded_at).toBeInstanceOf(Date);

    // Partial unique index prevents duplicate (media_id, season, namespace_group)
    await expect(
      testDb.writeDb
        .insertInto("demands")
        .values({
          media_id: insertedMedia.id,
          season: 2,
          namespace_group: "platform",
        })
        .execute(),
    ).rejects.toThrow();

    // Null season uniqueness also enforced via COALESCE(season, -1)
    await testDb.writeDb
      .insertInto("demands")
      .values({
        media_id: insertedMedia.id,
        season: null,
        namespace_group: "platform",
      })
      .execute();

    await expect(
      testDb.writeDb
        .insertInto("demands")
        .values({
          media_id: insertedMedia.id,
          season: null,
          namespace_group: "platform",
        })
        .execute(),
    ).rejects.toThrow();

    // External-key demand when media_id IS NULL
    const insertedExtDemand = await testDb.writeDb
      .insertInto("demands")
      .values({
        external_key: "tmdb:tv:77777",
        season: 1,
        namespace_group: "catalog",
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(insertedExtDemand).toMatchObject({
      media_id: null,
      external_key: "tmdb:tv:77777",
      season: 1,
      namespace_group: "catalog",
      demand_count: 1,
      status: "open",
    });

    // Partial unique index prevents duplicate (external_key, season, namespace_group)
    await expect(
      testDb.writeDb
        .insertInto("demands")
        .values({
          external_key: "tmdb:tv:77777",
          season: 1,
          namespace_group: "catalog",
        })
        .execute(),
    ).rejects.toThrow();

    // XOR check rejects both media_id and external_key set, or both null
    await expect(
      testDb.writeDb
        .insertInto("demands")
        .values({
          media_id: insertedMedia.id,
          external_key: "tmdb:tv:95479",
          season: 3,
          namespace_group: "platform",
        })
        .execute(),
    ).rejects.toThrow();

    await expect(
      testDb.writeDb
        .insertInto("demands")
        .values({
          media_id: null,
          external_key: null,
          season: 3,
          namespace_group: "platform",
        })
        .execute(),
    ).rejects.toThrow();

    // Rejects invalid namespace_group, status, negative season, and demand_count < 1
    await expect(
      testDb.writeDb
        .insertInto("demands")
        .values({
          media_id: insertedMedia.id,
          season: 3,
          namespace_group: "other" as any,
        })
        .execute(),
    ).rejects.toThrow();

    await expect(
      testDb.writeDb
        .insertInto("demands")
        .values({
          media_id: insertedMedia.id,
          season: 3,
          namespace_group: "platform",
          status: "unknown" as any,
        })
        .execute(),
    ).rejects.toThrow();

    await expect(
      testDb.writeDb
        .insertInto("demands")
        .values({
          media_id: insertedMedia.id,
          season: -1,
          namespace_group: "platform",
        })
        .execute(),
    ).rejects.toThrow();

    await expect(
      testDb.writeDb
        .insertInto("demands")
        .values({
          media_id: insertedMedia.id,
          season: 3,
          namespace_group: "platform",
          demand_count: 0,
        })
        .execute(),
    ).rejects.toThrow();

    // Invalidation reports table from 0011_invalidation_reports
    const openAnonReport = await testDb.writeDb
      .insertInto("invalidation_reports")
      .values({
        association_id: assoc.id,
        reporter_type: "api_key",
        reporter_user_id: "user_1",
        reporter_key_id: "key_1",
        reason: "404 on bilibili",
        recheck_job_id: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(openAnonReport).toMatchObject({
      association_id: assoc.id,
      reporter_type: "api_key",
      reporter_user_id: "user_1",
      reporter_key_id: "key_1",
      reason: "404 on bilibili",
      recheck_job_id: null,
    });
    expect(openAnonReport.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(openAnonReport.created_at).toBeInstanceOf(Date);

    // Partial unique index rejects duplicate open anonymous reports from the same API key
    await expect(
      testDb.writeDb
        .insertInto("invalidation_reports")
        .values({
          association_id: assoc.id,
          reporter_type: "api_key",
          reporter_user_id: "user_1",
          reporter_key_id: "key_1",
          reason: "duplicate spam",
          recheck_job_id: null,
        })
        .execute(),
    ).rejects.toThrow();

    // Closing the cycle by attaching recheck_job_id frees the partial unique index for a new cycle
    await testDb.writeDb
      .updateTable("invalidation_reports")
      .set({ recheck_job_id: insertedJob.id })
      .where("id", "=", openAnonReport.id)
      .execute();

    const nextCycleReport = await testDb.writeDb
      .insertInto("invalidation_reports")
      .values({
        association_id: assoc.id,
        reporter_type: "api_key",
        reporter_user_id: "user_1",
        reporter_key_id: "key_1",
        reason: "down again later",
        recheck_job_id: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    expect(nextCycleReport.id).not.toBe(openAnonReport.id);

    // Rejects invalid reporter_type
    await expect(
      testDb.writeDb
        .insertInto("invalidation_reports")
        .values({
          association_id: assoc.id,
          reporter_type: "bot" as "user",
          reporter_user_id: "user_1",
        })
        .execute(),
    ).rejects.toThrow();

    // Logged-in user reports require reporter_user_id and can record multiple reports
    const userReport = await testDb.writeDb
      .insertInto("invalidation_reports")
      .values({
        association_id: assoc.id,
        reporter_type: "user",
        reporter_user_id: "user_1",
        reporter_key_id: null,
        reason: "verified gone",
        recheck_job_id: insertedJob.id,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    expect(userReport.id).toBeTruthy();

    // Exploration daily budget & TMDB daily export IDs from 0012_exploration_budget
    const insertedBudget = await testDb.writeDb
      .insertInto("exploration_daily_budget")
      .values({
        budget_date: "2026-11-23",
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(insertedBudget).toMatchObject({
      budget_date: "2026-11-23",
      consumed: 0,
    });
    expect(insertedBudget.updated_at).toBeInstanceOf(Date);

    // Rejects malformed budget_date and negative consumed count
    await expect(
      testDb.writeDb
        .insertInto("exploration_daily_budget")
        .values({
          budget_date: "2026/11/23",
          consumed: 0,
        })
        .execute(),
    ).rejects.toThrow();

    await expect(
      testDb.writeDb
        .insertInto("exploration_daily_budget")
        .values({
          budget_date: "2026-11-24",
          consumed: -1,
        })
        .execute(),
    ).rejects.toThrow();

    const insertedExportId = await testDb.writeDb
      .insertInto("tmdb_daily_export_ids")
      .values({
        media_type: "tv",
        tmdb_id: "95479",
        exported_date: "2026-11-23",
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(insertedExportId).toEqual({
      media_type: "tv",
      tmdb_id: "95479",
      exported_date: "2026-11-23",
    });

    // Duplicate (media_type, tmdb_id) primary key fails
    await expect(
      testDb.writeDb
        .insertInto("tmdb_daily_export_ids")
        .values({
          media_type: "tv",
          tmdb_id: "95479",
          exported_date: "2026-11-24",
        })
        .execute(),
    ).rejects.toThrow();

    // Rejects invalid media_type, empty tmdb_id, and malformed exported_date
    await expect(
      testDb.writeDb
        .insertInto("tmdb_daily_export_ids")
        .values({
          media_type: "anime" as any,
          tmdb_id: "95479",
          exported_date: "2026-11-23",
        })
        .execute(),
    ).rejects.toThrow();

    await expect(
      testDb.writeDb
        .insertInto("tmdb_daily_export_ids")
        .values({
          media_type: "movie",
          tmdb_id: "   ",
          exported_date: "2026-11-23",
        })
        .execute(),
    ).rejects.toThrow();

    await expect(
      testDb.writeDb
        .insertInto("tmdb_daily_export_ids")
        .values({
          media_type: "movie",
          tmdb_id: "550",
          exported_date: "11-23-2026",
        })
        .execute(),
    ).rejects.toThrow();

    const rerunResults = await runMigrations(testDb.writeDb);
    expect(rerunResults).toEqual([]);
  });

  test("createTestDb provisions an already-migrated ephemeral database by default", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const row = await testDb.readDb
      .selectFrom("schema_meta")
      .select(["key", "value"])
      .where("key", "=", "bootstrap_version")
      .executeTakeFirst();

    expect(row).toEqual({
      key: "bootstrap_version",
      value: "0001_initial",
    });
  });
});
