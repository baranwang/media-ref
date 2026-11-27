import type {
  ExecutionContext,
  Hyperdrive,
  Message,
  MessageBatch,
  Queue,
  ScheduledController,
} from "@cloudflare/workers-types";
import {
  createDefaultJobHandlers,
  createFakeOutboundClient,
  enqueueJob,
  EVIDENCE_CHECK_JOB_TYPE,
  getJobById,
  type JobQueueMessage,
} from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import workerDefault, { createBackgroundWorker } from "../src/index.ts";

interface TrackedMessage {
  message: Message<JobQueueMessage>;
  acked: boolean;
  retried: boolean;
  retryDelaySeconds?: number;
}

function createScheduledController(scheduledTime: Date): ScheduledController {
  return {
    scheduledTime: scheduledTime.getTime(),
    cron: "* * * * *",
    noRetry() {},
  };
}

function createQueueBatch(
  bodies: JobQueueMessage[],
  timestamp: Date = new Date(),
): {
  batch: MessageBatch<JobQueueMessage>;
  tracked: TrackedMessage[];
} {
  const tracked: TrackedMessage[] = bodies.map((body, index) => {
    const entry: TrackedMessage = {
      acked: false,
      retried: false,
      message: {
        id: `msg-${index + 1}-${body.jobId}-gen-${body.leaseGeneration}`,
        timestamp,
        body,
        attempts: 1,
        ack() {
          entry.acked = true;
        },
        retry(options) {
          entry.retried = true;
          entry.retryDelaySeconds = options?.delaySeconds;
        },
      },
    };
    return entry;
  });

  const batch: MessageBatch<JobQueueMessage> = {
    queue: "media-ref-jobs",
    messages: tracked.map((entry) => entry.message),
    metadata: {
      metrics: {
        backlogCount: tracked.length,
        backlogBytes: 0,
      },
    },
    ackAll() {
      for (const entry of tracked) {
        entry.acked = true;
      }
    },
    retryAll(options) {
      for (const entry of tracked) {
        entry.retried = true;
        entry.retryDelaySeconds = options?.delaySeconds;
      }
    },
  };

  return { batch, tracked };
}

describe("Background Worker pipeline", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  test("scheduled claims due jobs respecting run_after and priority and emits leaseGeneration 1", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T10:00:00.000Z");
    let now = t0;

    const { job: lowPriorityDue } = await enqueueJob(testDb.writeDb, {
      jobType: "echo",
      payload: { label: "low-due" },
      priority: 1,
      runAfter: new Date(t0.getTime() - 10_000),
    });
    const { job: highPriorityDue } = await enqueueJob(testDb.writeDb, {
      jobType: "echo",
      payload: { label: "high-due" },
      priority: 10,
      runAfter: new Date(t0.getTime() - 5_000),
    });
    const { job: futureJob } = await enqueueJob(testDb.writeDb, {
      jobType: "echo",
      payload: { label: "future" },
      priority: 100,
      runAfter: new Date(t0.getTime() + 60_000),
    });

    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound: createFakeOutboundClient(),
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      config: {
        batchSize: 10,
        leaseDurationMs: 5 * 60_000,
      },
      now: () => now,
    });

    await worker.scheduled(createScheduledController(now));

    expect(emitted).toEqual([
      {
        jobId: highPriorityDue.id,
        jobType: "echo",
        leaseGeneration: 1,
        payload: { label: "high-due" },
      },
      {
        jobId: lowPriorityDue.id,
        jobType: "echo",
        leaseGeneration: 1,
        payload: { label: "low-due" },
      },
    ]);

    // Advance clock to T0 + 60s: futureJob becomes due; leased jobs still have valid 5m leases
    emitted.length = 0;
    now = new Date(t0.getTime() + 60_000);
    await worker.scheduled(createScheduledController(now));

    expect(emitted).toEqual([
      {
        jobId: futureJob.id,
        jobType: "echo",
        leaseGeneration: 1,
        payload: { label: "future" },
      },
    ]);
  });

  test("duplicate queue delivery applies the transactional effect only once", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T11:00:00.000Z");
    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound: createFakeOutboundClient(),
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      handlers: createDefaultJobHandlers(),
      now: () => t0,
    });

    const { job: seqJob } = await enqueueJob(testDb.writeDb, {
      jobType: "record_marker",
      payload: { key: "marker:dup-seq", mode: "increment" },
      runAfter: t0,
    });

    await worker.scheduled(createScheduledController(t0));
    expect(emitted).toHaveLength(1);
    const firstMsg = emitted[0]!;

    // Sequential duplicate delivery
    const delivery1 = createQueueBatch([firstMsg], t0);
    await worker.queue(delivery1.batch);
    const delivery2 = createQueueBatch([firstMsg], t0);
    await worker.queue(delivery2.batch);

    expect(delivery1.tracked[0]?.acked).toBe(true);
    expect(delivery2.tracked[0]?.acked).toBe(true);

    const seqMeta = await testDb.readDb
      .selectFrom("schema_meta")
      .select("value")
      .where("key", "=", "marker:dup-seq")
      .executeTakeFirstOrThrow();
    expect(seqMeta.value).toBe("1");

    const completedJob = await getJobById(testDb.readDb, seqJob.id);
    expect(completedJob?.status).toBe("completed");
    expect(completedJob?.leaseGeneration).toBe(1);

    // Concurrent duplicate delivery racing in parallel
    emitted.length = 0;
    await enqueueJob(testDb.writeDb, {
      jobType: "record_marker",
      payload: { key: "marker:dup-race", mode: "increment" },
      runAfter: t0,
    });
    await worker.scheduled(createScheduledController(t0));
    expect(emitted).toHaveLength(1);
    const raceMsg = emitted[0]!;

    const raceA = createQueueBatch([raceMsg], t0);
    const raceB = createQueueBatch([raceMsg], t0);
    await Promise.all([worker.queue(raceA.batch), worker.queue(raceB.batch)]);

    expect(raceA.tracked[0]?.acked).toBe(true);
    expect(raceB.tracked[0]?.acked).toBe(true);

    const raceMeta = await testDb.readDb
      .selectFrom("schema_meta")
      .select("value")
      .where("key", "=", "marker:dup-race")
      .executeTakeFirstOrThrow();
    expect(raceMeta.value).toBe("1");
  });

  test("lease expiration allows re-claim and fences out stale generation consumers (delayed and in-flight)", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T12:00:00.000Z");
    let now = t0;
    const leaseDurationMs = 30_000;

    let releaseInflightFetch!: (body: string) => void;
    let notifyInflightStarted!: () => void;
    const inflightStarted = new Promise<void>((resolve) => {
      notifyInflightStarted = resolve;
    });

    let inflightCallCount = 0;
    const outbound = createFakeOutboundClient({
      async fetchExternal(request) {
        if (request.url.includes("inflight")) {
          inflightCallCount += 1;
          if (inflightCallCount === 1) {
            notifyInflightStarted();
            const body = await new Promise<string>((resolve) => {
              releaseInflightFetch = resolve;
            });
            return { status: 200, headers: {}, body, url: request.url };
          }
          return { status: 200, headers: {}, body: "fresh-gen-2-inflight", url: request.url };
        }

        return { status: 200, headers: {}, body: "fresh-gen-2-delayed", url: request.url };
      },
    });

    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      handlers: createDefaultJobHandlers(),
      config: { leaseDurationMs },
      now: () => now,
    });

    // Case A: delayed stale delivery after lease expiration & re-claim
    const { job: delayedJob } = await enqueueJob(testDb.writeDb, {
      jobType: "record_marker",
      payload: { key: "marker:lease-delayed", probeUrl: "https://example.test/delayed" },
      runAfter: t0,
    });

    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(1);
    const delayedGen1 = emitted[0]!;
    expect(delayedGen1.leaseGeneration).toBe(1);

    // Before lease expiry (T0 + 15s), scheduled does not re-claim
    emitted.length = 0;
    now = new Date(t0.getTime() + 15_000);
    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(0);

    // After lease expiry (T2 = T0 + 35s), scheduled re-claims with leaseGeneration 2
    now = new Date(t0.getTime() + 35_000);
    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(1);
    const delayedGen2 = emitted[0]!;
    expect(delayedGen2.leaseGeneration).toBe(2);

    // Stale gen 1 arrives after re-claim -> discarded without even calling outbound
    const staleDelayedBatch = createQueueBatch([delayedGen1], now);
    const staleDelayedSummary = await worker.queue(staleDelayedBatch.batch);
    expect(staleDelayedSummary.discarded).toBe(1);
    expect(staleDelayedBatch.tracked[0]?.acked).toBe(true);
    expect(outbound.httpRequests).toHaveLength(0);

    // Fresh gen 2 writes cleanly
    const freshDelayedBatch = createQueueBatch([delayedGen2], now);
    const freshDelayedSummary = await worker.queue(freshDelayedBatch.batch);
    expect(freshDelayedSummary.completed).toBe(1);
    expect(freshDelayedBatch.tracked[0]?.acked).toBe(true);
    expect(outbound.httpRequests).toHaveLength(1);

    const delayedMeta = await testDb.readDb
      .selectFrom("schema_meta")
      .select("value")
      .where("key", "=", "marker:lease-delayed")
      .executeTakeFirstOrThrow();
    expect(delayedMeta.value).toBe("fresh-gen-2-delayed");
    expect((await getJobById(testDb.readDb, delayedJob.id))?.leaseGeneration).toBe(2);

    // Case B: true in-flight slow consumer whose lease expires mid-execution
    emitted.length = 0;
    now = new Date("2026-11-23T12:10:00.000Z");
    const { job: inflightJob } = await enqueueJob(testDb.writeDb, {
      jobType: "record_marker",
      payload: { key: "marker:lease-inflight", probeUrl: "https://example.test/inflight" },
      runAfter: now,
    });

    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(1);
    const inflightGen1 = emitted[0]!;
    expect(inflightGen1.leaseGeneration).toBe(1);

    // Start slow consumer gen 1 and wait until it is mid-flight inside OutboundClient
    const slowGen1Batch = createQueueBatch([inflightGen1], now);
    const slowGen1Promise = worker.queue(slowGen1Batch.batch);
    await inflightStarted;

    // Lease expires while gen 1 is in-flight; scheduled re-claims at T2 with gen 2
    emitted.length = 0;
    now = new Date(now.getTime() + leaseDurationMs + 5_000);
    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(1);
    const inflightGen2 = emitted[0]!;
    expect(inflightGen2.leaseGeneration).toBe(2);

    // Slow gen 1 now finishes and tries to commit -> fenced out & discarded!
    releaseInflightFetch("stale-gen-1-should-be-discarded");
    const slowGen1Summary = await slowGen1Promise;
    expect(slowGen1Summary.discarded).toBe(1);
    expect(slowGen1Batch.tracked[0]?.acked).toBe(true);

    const inflightMetaAfterStale = await testDb.readDb
      .selectFrom("schema_meta")
      .select("value")
      .where("key", "=", "marker:lease-inflight")
      .executeTakeFirst();
    expect(inflightMetaAfterStale).toBeUndefined();

    const jobAfterStale = await getJobById(testDb.readDb, inflightJob.id);
    expect(jobAfterStale?.status).toBe("leased");
    expect(jobAfterStale?.leaseGeneration).toBe(2);

    // Now gen 2 runs and commits cleanly
    const freshGen2Batch = createQueueBatch([inflightGen2], now);
    const freshGen2Summary = await worker.queue(freshGen2Batch.batch);
    expect(freshGen2Summary.completed).toBe(1);
    expect(freshGen2Batch.tracked[0]?.acked).toBe(true);

    const inflightMetaAfterGen2 = await testDb.readDb
      .selectFrom("schema_meta")
      .select("value")
      .where("key", "=", "marker:lease-inflight")
      .executeTakeFirstOrThrow();
    expect(inflightMetaAfterGen2.value).toBe("fresh-gen-2-inflight");

    const completedInflight = await getJobById(testDb.readDb, inflightJob.id);
    expect(completedInflight?.status).toBe("completed");
    expect(completedInflight?.leaseGeneration).toBe(2);
    expect(completedInflight?.result).toMatchObject({
      key: "marker:lease-inflight",
      value: "fresh-gen-2-inflight",
      leaseGeneration: 2,
    });
  });

  test("only ordinary jobs can be reclaimed six minutes after exploration and ordinary jobs are claimed together", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const t0 = new Date("2026-11-23T12:00:00Z");
    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound: createFakeOutboundClient(),
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      config: { jobTypes: ["exploration", "echo"], enableExplorationScheduling: false },
    });
    const { job: exploration } = await enqueueJob(testDb.writeDb, {
      jobType: "exploration",
      runAfter: t0,
    });
    const { job: ordinary } = await enqueueJob(testDb.writeDb, { jobType: "echo", runAfter: t0 });
    await worker.scheduled(createScheduledController(t0));
    expect(emitted).toHaveLength(2);
    expect((await getJobById(testDb.readDb, exploration.id))?.leaseExpiresAt).toEqual(
      new Date(t0.getTime() + 10 * 60_000),
    );
    emitted.length = 0;
    await worker.scheduled(createScheduledController(new Date(t0.getTime() + 6 * 60_000)));
    expect(emitted).toEqual([expect.objectContaining({ jobId: ordinary.id, leaseGeneration: 2 })]);
  });

  test("a tmdb_sync lease outlasts the 15-minute invocation wall clock (#153)", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const t0 = new Date("2026-11-26T00:00:00Z");
    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound: createFakeOutboundClient(),
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      config: { jobTypes: ["tmdb_sync", "echo"], enableDailyTmdbSync: false },
    });
    const { job: sync } = await enqueueJob(testDb.writeDb, { jobType: "tmdb_sync", runAfter: t0 });
    const { job: ordinary } = await enqueueJob(testDb.writeDb, { jobType: "echo", runAfter: t0 });
    await worker.scheduled(createScheduledController(t0));
    expect(emitted).toHaveLength(2);
    expect((await getJobById(testDb.readDb, sync.id))?.leaseExpiresAt).toEqual(
      new Date(t0.getTime() + 20 * 60_000),
    );

    // A sync still running after the ordinary 5-minute lease is not claimed a second time.
    emitted.length = 0;
    await worker.scheduled(createScheduledController(new Date(t0.getTime() + 16 * 60_000)));
    expect(emitted).toEqual([expect.objectContaining({ jobId: ordinary.id, leaseGeneration: 2 })]);

    // Once the invocation that held it must have ended, the sync is claimed again.
    emitted.length = 0;
    await worker.scheduled(createScheduledController(new Date(t0.getTime() + 21 * 60_000)));
    expect(emitted).toEqual(
      expect.arrayContaining([expect.objectContaining({ jobId: sync.id, leaseGeneration: 2 })]),
    );
  });

  test("late exploration delivery keeps its generation through the original deadline", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const t0 = Date.parse("2026-11-23T12:00:00Z");
    let now = new Date(t0);
    const media = await testDb.writeDb
      .insertInto("media")
      .values({ type: "movie", baseline: "tmdb", title: "Late delivery" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const demand = await testDb.writeDb
      .insertInto("demands")
      .values({ media_id: media.id, namespace_group: "platform", next_eligible_at: now })
      .returning("id")
      .executeTakeFirstOrThrow();
    let signalStarted!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const running = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const generations: number[] = [];
    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound: createFakeOutboundClient(),
      now: () => now,
      config: { jobTypes: ["exploration"], exploration: { dailyBudget: 10 } },
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      explorationExecutor: async (ctx) => {
        generations.push(ctx.jobLeaseGeneration);
        if (generations.length === 1) {
          signalStarted();
          await running;
        }
        return {
          platformOutcomes: [{ namespace: "bilibili", status: "not_found", reason: "absent" }],
        };
      },
    });
    await worker.scheduled();
    expect(emitted).toHaveLength(1);
    now = new Date(t0 + 6 * 60_000);
    const message = emitted[0]!;
    const first = worker.queue(createQueueBatch([message], now).batch);
    await started;
    now = new Date(t0 + 10 * 60_000);
    let tick, duplicate;
    try {
      [tick, duplicate] = await Promise.all([
        worker.scheduled(),
        worker.queue(createQueueBatch([message], now).batch),
      ]);
    } finally {
      now = new Date(t0 + 11 * 60_000);
      finish();
    }
    expect((await first).completed).toBe(1);
    expect(generations).toEqual([1]);
    expect(duplicate.discarded).toBe(1);
    expect(tick.claimed).toBe(0);
    expect(await getJobById(testDb.readDb, message.jobId)).toMatchObject({
      status: "completed",
      leaseGeneration: 1,
      attempts: 1,
    });
    expect(
      await testDb.readDb
        .selectFrom("demands")
        .select(["status", "not_found_count"])
        .where("id", "=", demand.id)
        .executeTakeFirst(),
    ).toEqual({ status: "not_found", not_found_count: 1 });
  });

  test("expiry and concurrent reclaim fence exploration starts, and a crashed execution is reclaimed", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const t0 = Date.parse("2026-11-23T12:00:00Z");
    let now = new Date(t0);
    const emitted: JobQueueMessage[] = [];
    const generations: number[] = [];
    let signalStarted!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const running = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound: createFakeOutboundClient(),
      now: () => now,
      config: { jobTypes: ["exploration"], enableExplorationScheduling: false },
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      handlers: {
        async exploration(ctx) {
          generations.push(ctx.job.leaseGeneration);
          if (ctx.job.leaseGeneration === 2) {
            signalStarted();
            await running;
          }
          return { status: "completed", result: { generation: ctx.job.leaseGeneration } };
        },
      },
    });
    const { job } = await enqueueJob(testDb.writeDb, { jobType: "exploration", runAfter: now });
    await worker.scheduled();
    const first = emitted[0]!;
    const deliver = (msg: JobQueueMessage) => worker.queue(createQueueBatch([msg], now).batch);
    now = new Date(t0 + 10 * 60_000);
    expect((await deliver(first)).discarded).toBe(1);
    const [late, tick] = await Promise.all([deliver(first), worker.scheduled()]);
    expect(late.discarded).toBe(1);
    expect(tick.claimed).toBe(1);
    expect((await deliver(first)).discarded).toBe(1);
    expect(generations).toEqual([]);
    now = new Date(t0 + 11 * 60_000);
    const stalled = deliver(emitted[1]!);
    await started;
    try {
      now = new Date(t0 + 21 * 60_000);
      expect((await worker.scheduled()).claimed).toBe(1);
      expect((await deliver(emitted[2]!)).completed).toBe(1);
    } finally {
      finish();
    }
    expect((await stalled).discarded).toBe(1);
    expect(generations).toEqual([2, 3]);
    expect(await getJobById(testDb.readDb, job.id)).toMatchObject({
      attempts: 3,
      result: { generation: 3 },
    });
  });

  test("an older exploration message is redispatched without spending its last attempt", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const now = new Date("2026-11-23T12:00:00Z");
    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound: createFakeOutboundClient(),
      now: () => now,
      config: { jobTypes: ["exploration"], enableExplorationScheduling: false },
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      handlers: {
        async exploration() {
          return { status: "completed" };
        },
      },
    });
    const { job } = await enqueueJob(testDb.writeDb, {
      jobType: "exploration",
      runAfter: now,
      maxAttempts: 1,
    });
    await worker.scheduled();
    const legacy = { ...emitted[0]! };
    delete legacy.dispatchLeaseExpiresAt;
    await worker.queue(createQueueBatch([legacy], now).batch);
    expect(await getJobById(testDb.readDb, job.id)).toMatchObject({
      status: "pending",
      attempts: 0,
    });
    await worker.scheduled();
    const { completed, discarded } = await worker.queue(
      createQueueBatch([legacy, emitted[1]!], now).batch,
    );
    expect({ completed, discarded }).toEqual({ completed: 1, discarded: 1 });
    expect(await getJobById(testDb.readDb, job.id)).toMatchObject({
      status: "completed",
      attempts: 1,
      leaseGeneration: 2,
    });
  });

  test("queue dispatch failure releases lease and allows re-claim on a subsequent scheduled tick", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T13:00:00.000Z");
    let now = t0;

    const { job } = await enqueueJob(testDb.writeDb, {
      jobType: "record_marker",
      payload: { key: "marker:dispatch-recovery", value: "dispatched-on-retry" },
      maxAttempts: 1,
      runAfter: t0,
    });

    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let sendCalls = 0;
    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound: createFakeOutboundClient(),
      queue: {
        async send(message) {
          sendCalls += 1;
          if (sendCalls === 1) {
            throw new Error("Queue HTTP 503: private response body");
          }
          emitted.push(message);
        },
      },
      handlers: createDefaultJobHandlers(),
      config: { leaseDurationMs: 60_000 },
      now: () => now,
    });

    // Tick 1: queue.send throws -> lease released back to pending without burning attempts
    const firstTick = await worker.scheduled(createScheduledController(now));
    expect(firstTick).toEqual({
      claimed: 1,
      dispatched: 0,
      dispatchFailed: 1,
    });
    expect(emitted).toHaveLength(0);

    expect(logged.mock.calls).toEqual([
      [
        {
          event: "job_dispatch_failed",
          jobId: job.id,
          jobType: "record_marker",
          error: "Upstream HTTP 503",
        },
      ],
    ]);
    const releasedJob = await getJobById(testDb.readDb, job.id);
    expect(releasedJob?.status).toBe("pending");
    expect(releasedJob?.leaseGeneration).toBe(1);
    expect(releasedJob?.attempts).toBe(0);
    expect(releasedJob?.leaseExpiresAt).toBeNull();

    // Tick 2: job is immediately re-claimed (leaseGeneration 2) and dispatched
    now = new Date(t0.getTime() + 1_000);
    const secondTick = await worker.scheduled(createScheduledController(now));
    expect(secondTick).toEqual({
      claimed: 1,
      dispatched: 1,
      dispatchFailed: 0,
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.leaseGeneration).toBe(2);

    // Even if a phantom message with generation 1 showed up, it is fenced out
    const phantomBatch = createQueueBatch([{ ...emitted[0]!, leaseGeneration: 1 }], now);
    const phantomSummary = await worker.queue(phantomBatch.batch);
    expect(phantomSummary.discarded).toBe(1);

    // Delivering the generation 2 message succeeds
    const validBatch = createQueueBatch([emitted[0]!], now);
    const validSummary = await worker.queue(validBatch.batch);
    expect(validSummary.completed).toBe(1);

    const meta = await testDb.readDb
      .selectFrom("schema_meta")
      .select("value")
      .where("key", "=", "marker:dispatch-recovery")
      .executeTakeFirstOrThrow();
    expect(meta.value).toBe("dispatched-on-retry");
  });

  test("a failed evidence sweep still dispatches due jobs", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const now = new Date("2026-11-23T13:00:00Z");
    const { job } = await enqueueJob(testDb.writeDb, { jobType: "echo", runAfter: now });
    // Simulate a schema mismatch in this test's database, limited to the evidence sweep.
    await testDb.writeDb.schema
      .alterTable("change_requests")
      .renameTo("unavailable_change_requests")
      .execute();
    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound: createFakeOutboundClient(),
      config: { jobTypes: [EVIDENCE_CHECK_JOB_TYPE, "echo"] },
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
    });
    expect(await worker.scheduled(createScheduledController(now))).toEqual({
      claimed: 1,
      dispatched: 1,
      dispatchFailed: 0,
    });
    expect(emitted).toEqual([expect.objectContaining({ jobId: job.id, leaseGeneration: 1 })]);
  });

  test("retryable handler errors reschedule with backoff and fail once maxAttempts are exhausted", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T14:00:00.000Z");
    let now = t0;
    let upstreamAttempts = 0;

    const outbound = createFakeOutboundClient({
      async fetchExternal(request) {
        upstreamAttempts += 1;
        if (request.url.includes("recover")) {
          if (upstreamAttempts === 1) {
            return { status: 503, headers: {}, body: "unavailable", url: request.url };
          }
          return { status: 200, headers: {}, body: "recovered-ok", url: request.url };
        }
        return { status: 503, headers: {}, body: "still-down", url: request.url };
      },
    });

    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      handlers: createDefaultJobHandlers(),
      config: { defaultRetryDelayMs: 30_000 },
      now: () => now,
    });

    const { job: recoveringJob } = await enqueueJob(testDb.writeDb, {
      jobType: "record_marker",
      payload: { key: "marker:retry-ok", probeUrl: "https://example.test/recover" },
      maxAttempts: 2,
      runAfter: t0,
    });

    await worker.scheduled(createScheduledController(now));
    const attempt1 = createQueueBatch([emitted.shift()!], now);
    const attempt1Summary = await worker.queue(attempt1.batch);
    expect(attempt1Summary.rescheduled).toBe(1);
    expect(attempt1.tracked[0]?.acked).toBe(true);

    // Before backoff window elapses, scheduled does not claim it
    now = new Date(t0.getTime() + 10_000);
    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(0);

    // After backoff window elapses, scheduled claims attempt 2 and succeeds
    now = new Date(t0.getTime() + 30_000);
    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.leaseGeneration).toBe(2);

    const attempt2 = createQueueBatch([emitted.shift()!], now);
    const attempt2Summary = await worker.queue(attempt2.batch);
    expect(attempt2Summary.completed).toBe(1);

    const completed = await getJobById(testDb.readDb, recoveringJob.id);
    expect(completed?.status).toBe("completed");
    expect(completed?.attempts).toBe(2);

    // Exhausting maxAttempts transitions the job to failed
    const { job: failingJob } = await enqueueJob(testDb.writeDb, {
      jobType: "record_marker",
      payload: { key: "marker:retry-fail", probeUrl: "https://example.test/always-503" },
      maxAttempts: 1,
      runAfter: now,
    });

    await worker.scheduled(createScheduledController(now));
    const exhausted = createQueueBatch([emitted.shift()!], now);
    const exhaustedSummary = await worker.queue(exhausted.batch);
    expect(exhaustedSummary.failed).toBe(1);
    expect(exhausted.tracked[0]?.acked).toBe(true);

    const failedRow = await getJobById(testDb.readDb, failingJob.id);
    expect(failedRow?.status).toBe("failed");
    expect(failedRow?.errorMessage).toBe("upstream_status_503");
  });

  test("enqueueJob deduplicates active jobs by dedupeKey and allows re-enqueue after completion", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T15:00:00.000Z");
    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound: createFakeOutboundClient(),
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      handlers: createDefaultJobHandlers(),
      now: () => t0,
    });

    const first = await enqueueJob(testDb.writeDb, {
      jobType: "echo",
      dedupeKey: "evidence:cr-123",
      payload: { changeRequestId: "cr-123" },
      runAfter: t0,
    });
    expect(first.created).toBe(true);

    // Duplicate while pending returns the same job
    const dupPending = await enqueueJob(testDb.writeDb, {
      jobType: "echo",
      dedupeKey: "evidence:cr-123",
      payload: { changeRequestId: "cr-123" },
      runAfter: t0,
    });
    expect(dupPending.created).toBe(false);
    expect(dupPending.job.id).toBe(first.job.id);

    // Lease the job via scheduled; duplicate while leased still returns the same job
    await worker.scheduled(createScheduledController(t0));
    const dupLeased = await enqueueJob(testDb.writeDb, {
      jobType: "echo",
      dedupeKey: "evidence:cr-123",
      payload: { changeRequestId: "cr-123" },
      runAfter: t0,
    });
    expect(dupLeased.created).toBe(false);
    expect(dupLeased.job.id).toBe(first.job.id);

    // Complete via queue; afterwards the same dedupeKey can be scheduled again
    const batch = createQueueBatch([emitted.shift()!], t0);
    await worker.queue(batch.batch);

    const reEnqueued = await enqueueJob(testDb.writeDb, {
      jobType: "echo",
      dedupeKey: "evidence:cr-123",
      payload: { changeRequestId: "cr-123", rerun: true },
      runAfter: t0,
    });
    expect(reEnqueued.created).toBe(true);
    expect(reEnqueued.job.id).not.toBe(first.job.id);
  });

  test("production createBackgroundWorker does NOT register test-only echo/record_marker handlers", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T15:30:00.000Z");
    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound: createFakeOutboundClient(),
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      now: () => t0,
    });

    const { job: echoJob } = await enqueueJob(testDb.writeDb, {
      jobType: "echo",
      payload: { label: "should-not-run" },
      runAfter: t0,
    });
    const { job: markerJob } = await enqueueJob(testDb.writeDb, {
      jobType: "record_marker",
      payload: { key: "marker:should-not-run", probeUrl: "https://internal.example.test/ssrf" },
      runAfter: t0,
    });

    await worker.scheduled(createScheduledController(t0));
    expect(emitted).toHaveLength(2);

    const { batch, tracked } = createQueueBatch(emitted, t0);
    const summary = await worker.queue(batch);
    expect(summary.failed).toBe(2);
    expect(summary.completed).toBe(0);
    expect(tracked.every((t) => t.acked)).toBe(true);

    const echoRow = await getJobById(testDb.readDb, echoJob.id);
    expect(echoRow?.status).toBe("failed");
    expect(echoRow?.errorMessage).toContain('No handler registered for job type "echo"');

    const markerRow = await getJobById(testDb.readDb, markerJob.id);
    expect(markerRow?.status).toBe("failed");
    expect(markerRow?.errorMessage).toContain('No handler registered for job type "record_marker"');
  });

  test("default Cloudflare Worker scheduled and queue entrypoints run end-to-end via Hyperdrive and Queue bindings", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T16:00:00.000Z");
    const missingChangeRequestId = "00000000-0000-4000-8000-000000000001";
    const { job } = await enqueueJob(testDb.writeDb, {
      jobType: EVIDENCE_CHECK_JOB_TYPE,
      payload: { changeRequestId: missingChangeRequestId },
      runAfter: t0,
    });

    const emitted: JobQueueMessage[] = [];
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;

    const env = {
      HYPERDRIVE_WRITE: {
        connectionString: testDb.connectionString,
      } as Hyperdrive,
      JOBS_QUEUE: {
        async send(message: JobQueueMessage) {
          emitted.push(message);
        },
      } as unknown as Queue<JobQueueMessage>,
      ENABLE_DAILY_TMDB_EXPORTS_SYNC: "false",
    };

    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    await workerDefault.scheduled(createScheduledController(t0), env, ctx);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.jobId).toBe(job.id);

    const { batch, tracked } = createQueueBatch(emitted, t0);
    await workerDefault.queue(batch, env, ctx);
    await Promise.all(pending);
    expect(logged.mock.calls).toEqual([
      [{ event: "scheduled_run", claimed: 1, dispatched: 1, dispatchFailed: 0 }],
      [
        {
          event: "queue_batch",
          processed: 1,
          completed: 1,
          discarded: 0,
          rescheduled: 0,
          failed: 0,
          retriedInQueue: 0,
        },
      ],
    ]);

    expect(tracked[0]?.acked).toBe(true);
    const completedJob = await getJobById(testDb.readDb, job.id);
    expect(completedJob?.status).toBe("completed");
    expect(completedJob?.result).toMatchObject({
      changeRequestId: missingChangeRequestId,
      skipped: true,
      reason: "change_request_not_found",
    });
  });

  test("concurrent scheduled ticks claim each due job at most once via FOR UPDATE SKIP LOCKED", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T17:00:00.000Z");
    const jobIds: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const { job } = await enqueueJob(testDb.writeDb, {
        jobType: "echo",
        payload: { index: i },
        runAfter: t0,
      });
      jobIds.push(job.id);
    }

    const emittedA: JobQueueMessage[] = [];
    const emittedB: JobQueueMessage[] = [];

    const workerA = createBackgroundWorker({
      db: testDb.writeDb,
      outbound: createFakeOutboundClient(),
      queue: {
        async send(message) {
          emittedA.push(message);
        },
      },
      config: { batchSize: 4 },
      now: () => t0,
    });
    const workerB = createBackgroundWorker({
      db: testDb.readDb,
      outbound: createFakeOutboundClient(),
      queue: {
        async send(message) {
          emittedB.push(message);
        },
      },
      config: { batchSize: 4 },
      now: () => t0,
    });

    await Promise.all([
      workerA.scheduled(createScheduledController(t0)),
      workerB.scheduled(createScheduledController(t0)),
    ]);

    const allClaimedIds = [...emittedA, ...emittedB].map((msg) => msg.jobId);
    expect(allClaimedIds).toHaveLength(4);
    expect(new Set(allClaimedIds)).toEqual(new Set(jobIds));
  });
});
