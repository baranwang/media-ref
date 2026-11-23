import type { ExecutionContext, Hyperdrive } from "@cloudflare/workers-types";
import { createLiveOutboundClient, parseOutboundProxyConfig } from "@media-ref/core";
import { createDb } from "@media-ref/db";
import { createApiApp } from "./app.ts";

export { createApiApp, type ApiConfig, type ApiDeps } from "./app.ts";

export interface ApiWorkerEnv {
  HYPERDRIVE_READ: Hyperdrive;
  HYPERDRIVE_WRITE: Hyperdrive;
  OUTBOUND_PROXY_CONFIG?: string;
  ENABLE_HEALTH_OUTBOUND_PROBE?: string;
}

const worker = {
  async fetch(request: Request, env: ApiWorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const dbRead = createDb(env.HYPERDRIVE_READ.connectionString, { max: 5 });
    const dbWrite = createDb(env.HYPERDRIVE_WRITE.connectionString, { max: 5 });

    const app = createApiApp({
      dbRead,
      dbWrite,
      outbound: createLiveOutboundClient({
        proxyConfig: parseOutboundProxyConfig(env.OUTBOUND_PROXY_CONFIG),
      }),
      config: {
        enableHealthOutboundProbe: env.ENABLE_HEALTH_OUTBOUND_PROBE === "true",
      },
    });

    try {
      return await app.fetch(request);
    } finally {
      ctx.waitUntil(Promise.allSettled([dbRead.destroy(), dbWrite.destroy()]));
    }
  },
};

export default worker;
