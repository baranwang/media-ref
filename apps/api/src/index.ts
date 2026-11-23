import type { ExecutionContext, Hyperdrive, SendEmail } from "@cloudflare/workers-types";
import { createLiveOutboundClient, parseOutboundProxyConfig } from "@media-ref/core";
import { createDb } from "@media-ref/db";
import { createApiApp } from "./app.ts";
import { DEFAULT_EMAIL_FROM } from "./auth.ts";

export { createApiApp, type ApiConfig, type ApiDeps } from "./app.ts";
export {
  AUTH_BASE_PATH,
  createAuth,
  DEFAULT_API_BASE_URL,
  DEFAULT_EMAIL_FROM,
  getAuthenticatedSession,
  isAllowedCorsOrigin,
  requireAuthenticatedSession,
  requireVerifiedUser,
  resolveTrustedOrigins,
  type ApiEnv,
  type AuthConfig,
  type AuthDeps,
  type AuthenticatedSession,
  type AuthenticatedUser,
  type AuthInstance,
} from "./auth.ts";

export interface ApiWorkerEnv {
  HYPERDRIVE_READ: Hyperdrive;
  HYPERDRIVE_WRITE: Hyperdrive;
  EMAIL?: SendEmail;
  EMAIL_FROM?: string;
  AUTH_SECRET?: string;
  API_BASE_URL?: string;
  COOKIE_DOMAIN?: string;
  TRUSTED_ORIGINS?: string;
  OUTBOUND_PROXY_CONFIG?: string;
  ENABLE_HEALTH_OUTBOUND_PROBE?: string;
}

function parseTrustedOrigins(raw: string | undefined): string[] | undefined {
  if (!raw || raw.trim() === "") {
    return undefined;
  }
  const parsed = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return parsed.length > 0 ? parsed : undefined;
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
        emailBinding: env.EMAIL,
        defaultEmailFrom: env.EMAIL_FROM ?? DEFAULT_EMAIL_FROM,
      }),
      config: {
        enableHealthOutboundProbe: env.ENABLE_HEALTH_OUTBOUND_PROBE === "true",
        baseUrl: env.API_BASE_URL,
        authSecret: env.AUTH_SECRET,
        cookieDomain: env.COOKIE_DOMAIN,
        emailFrom: env.EMAIL_FROM,
        trustedOrigins: parseTrustedOrigins(env.TRUSTED_ORIGINS),
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
