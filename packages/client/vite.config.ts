import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts", "src/proto.ts"],
    deps: {
      resolveDepSubpath: true,
    },
    dts: {
      generator: "tsgo",
    },
    exports: {
      devExports: true,
      // Website-only RPCs stay inside the workspace: never in dist or the published exports.
      customExports: (exports, { isPublish }) =>
        isPublish ? exports : { ...exports, "./internal": "./src/internal.ts" },
    },
  },
});
