import { defineConfig } from "vite-plus";

const VIRTUAL_CLOUDFLARE_WORKERS_ID = "\0virtual:cloudflare-workers-test-shim";

const CLOUDFLARE_WORKERS_SHIM_SOURCE = `
export class WorkerEntrypoint {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
`;

export default defineConfig({
  plugins: [
    {
      name: "cloudflare-workers-test-shim",
      resolveId(id) {
        if (id === "cloudflare:workers") {
          return VIRTUAL_CLOUDFLARE_WORKERS_ID;
        }
        return null;
      },
      load(id) {
        if (id === VIRTUAL_CLOUDFLARE_WORKERS_ID) {
          return CLOUDFLARE_WORKERS_SHIM_SOURCE;
        }
        return null;
      },
    },
  ],
});
