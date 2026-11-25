import { WorkerEntrypoint } from "cloudflare:workers";
import worker, { handleWorkerRequest } from "./index.ts";
import type { ApiWorkerEnv } from "./worker-env.ts";

// Deploy entry (wrangler `main`). Kept apart from `index.ts` because `cloudflare:workers`
// only resolves inside workerd, while tests import `index.ts` under Node.

/**
 * Named entrypoint for the website server's service binding. It is not reachable from the
 * public internet, so requests through it are treated as internal (keyless public reads).
 */
export class InternalApi extends WorkerEntrypoint<ApiWorkerEnv> {
  override fetch(request: Request): Promise<Response> {
    return handleWorkerRequest(request, this.env, this.ctx, true);
  }
}

export default worker;
