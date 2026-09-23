import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

await esbuild({
  entryPoints: [
    path.resolve(artifactDir, "src/admin.test.ts"),
    path.resolve(artifactDir, "src/cleanup-admin-test-users.test.ts"),
    path.resolve(artifactDir, "src/lib/channel-moderation-policy.test.ts"),
    path.resolve(artifactDir, "src/lib/cors.test.ts"),
    path.resolve(artifactDir, "src/lib/ws.test.ts"),
    path.resolve(artifactDir, "src/lib/fixed-window-limiter.test.ts"),
    path.resolve(artifactDir, "src/routes/storage.test.ts"),
    path.resolve(artifactDir, "src/lib/validation.test.ts"),
  ],
  platform: "node",
  bundle: true,
  format: "cjs",
  outdir: path.resolve(artifactDir, "dist-tests"),
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