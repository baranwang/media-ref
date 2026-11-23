import type {
  Ai,
  ExecutionContext,
  Hyperdrive,
  MessageBatch,
  Queue,
  ScheduledController,
} from "@cloudflare/workers-types";
import {
  createLiveOutboundClient,
  type JobQueueMessage,
  parseOutboundProxyConfig,
} from "@media-ref/core";
import { createDb } from "@media-ref/db";
import {
  createBackgroundWorker,
  DEFAULT_JOB_BATCH_SIZE,
  DEFAULT_LEASE_DURATION_MS,
  type BackgroundWorkerConfig,
} from "./worker.ts";

export {
  createBackgroundWorker,
  DEFAULT_JOB_BATCH_SIZE,
  DEFAULT_LEASE_DURATION_MS,
  DEFAULT_RETRY_DELAY_MS,
  type BackgroundWorker,
  type BackgroundWorkerConfig,
  type BackgroundWorkerDeps,
  type QueueBatchSummary,
  type ScheduledRunSummary,
} from "./worker.ts";

export interface BackgroundWorkerEnv {
  HYPERDRIVE_WRITE: Hyperdrive;
  JOBS_QUEUE: Queue<JobQueueMessage>;
  AI?: Ai;
  OUTBOUND_PROXY_CONFIG?: string;
  JOB_BATCH_SIZE?: string;
  JOB_LEASE_DURATION_MS?: string;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseWorkerConfig(env: BackgroundWorkerEnv): BackgroundWorkerConfig {
  return {
    batchSize: parsePositiveInt(env.JOB_BATCH_SIZE, DEFAULT_JOB_BATCH_SIZE),
    leaseDurationMs: parsePositiveInt(env.JOB_LEASE_DURATION_MS, DEFAULT_LEASE_DURATION_MS),
  };
}

const worker = {
  async scheduled(
    controller: ScheduledController,
    env: BackgroundWorkerEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    const db = createDb(env.HYPERDRIVE_WRITE.connectionString, { max: 5 });
    const instance = createBackgroundWorker({
      db,
      outbound: createLiveOutboundClient({
        proxyConfig: parseOutboundProxyConfig(env.OUTBOUND_PROXY_CONFIG),
      }),
      queue: env.JOBS_QUEUE,
      config: parseWorkerConfig(env),
    });

    try {
      await instance.scheduled(controller, env, ctx);
    } finally {
      ctx.waitUntil(db.destroy());
    }
  },

  async queue(
    batch: MessageBatch<JobQueueMessage>,
    env: BackgroundWorkerEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    const db = createDb(env.HYPERDRIVE_WRITE.connectionString, { max: 5 });
    const instance = createBackgroundWorker({
      db,
      outbound: createLiveOutboundClient({
        proxyConfig: parseOutboundProxyConfig(env.OUTBOUND_PROXY_CONFIG),
      }),
      queue: env.JOBS_QUEUE,
      config: parseWorkerConfig(env),
    });

    try {
      await instance.queue(batch, env, ctx);
    } finally {
      ctx.waitUntil(db.destroy());
    }
  },
};

export default worker;
