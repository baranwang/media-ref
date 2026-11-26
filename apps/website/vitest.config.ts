import { defineConfig } from "vite-plus";

// Tests skip vite.config.ts: its Cloudflare plugin cannot load inside the test runner.
export default defineConfig({});
