import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

await esbuild({
  entryPoints: [path.resolve(artifactDir, "src/cleanup-admin-test-users.ts")],
  platform: "node",
  bundle: true,
  format: "cjs",
  outdir: path.resolve(artifactDir, "dist-cleanup"),
  outExtension: { ".js": ".cjs" },
  sourcemap: "linked",
  logLevel: "info",
  external: [
    "*.node",
    "pg-native",
    "bufferutil",
    "utf-8-validate",
    "fsevents",
  ],
  plugins: [
    esbuildPluginPino({ transports: ["pino-pretty"] }),
  ],
});