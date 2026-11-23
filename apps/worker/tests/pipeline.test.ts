import type {
  ExecutionContext,
  Hyperdrive,
  Message,
  MessageBatch,
  Queue,
  ScheduledController,
} from "@cloudflare/workers-types";
import {
  createFakeOutboundClient,
  enqueueJob,
  getJobById,
  type JobQueueMessage,
} from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
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

    let sendCalls = 0;
    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound: createFakeOutboundClient(),
      queue: {
        async send(message) {
          sendCalls += 1;
          if (sendCalls === 1) {
            throw new Error("Simulated Cloudflare Queue send failure");
          }
          emitted.push(message);
        },
      },
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

  test("default Cloudflare Worker scheduled and queue entrypoints run end-to-end via Hyperdrive and Queue bindings", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T16:00:00.000Z");
    const { job } = await enqueueJob(testDb.writeDb, {
      jobType: "record_marker",
      payload: { key: "marker:default-export", value: "from-cf-worker" },
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
    };

    await workerDefault.scheduled(createScheduledController(t0), env, ctx);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.jobId).toBe(job.id);

    const { batch, tracked } = createQueueBatch(emitted, t0);
    await workerDefault.queue(batch, env, ctx);
    await Promise.all(pending);

    expect(tracked[0]?.acked).toBe(true);
    const meta = await testDb.readDb
      .selectFrom("schema_meta")
      .select("value")
      .where("key", "=", "marker:default-export")
      .executeTakeFirstOrThrow();
    expect(meta.value).toBe("from-cf-worker");
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
