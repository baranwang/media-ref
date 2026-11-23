declare module "cloudflare:workers" {
  import type { ExecutionContext } from "@cloudflare/workers-types";

  export abstract class WorkerEntrypoint<Env = unknown, Props = unknown> {
    protected readonly ctx: ExecutionContext<Props>;
    protected readonly env: Env;
    constructor(ctx: ExecutionContext<Props>, env: Env);
    fetch?(request: Request): Response | Promise<Response>;
  }
}
