// Minimal typing for the workerd built-in module; the project does not load the global
// @cloudflare/workers-types ambient declarations (they clash with Node types).
declare module "cloudflare:workers" {
  import type { ExecutionContext } from "@cloudflare/workers-types";

  export abstract class WorkerEntrypoint<Env = unknown> {
    protected ctx: ExecutionContext;
    protected env: Env;
    constructor(ctx: ExecutionContext, env: Env);
    fetch?(request: Request): Response | Promise<Response>;
  }
}
