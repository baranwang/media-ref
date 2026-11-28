import { defineConfig } from "vite-plus";
import { paraglideVitePlugin } from "@inlang/paraglide-js";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { fumadocsMdx } from "fumadocs-mdx/vite";

const config = defineConfig(({ command }) => ({
  resolve: { tsconfigPaths: true },
  plugins: [
    fumadocsMdx(),
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/paraglide",
      strategy: ["url", "baseLocale"],
    }),
    cloudflare({
      viteEnvironment: { name: "ssr" },
      // Dev only: run the API Worker next to the site so the `API` service binding resolves locally.
      auxiliaryWorkers: command === "serve" ? [{ configPath: "../api/wrangler.jsonc" }] : [],
    }),
    tailwindcss(),
    tanstackStart({
      router: {
        quoteStyle: "double",
        semicolons: true,
      },
    }),
    viteReact(),
  ],
}));

export default config;
