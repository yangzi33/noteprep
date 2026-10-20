// Bundles the worker for production (D-53). Node packages stay external (installed with --prod);
// our own code, including the generated Prisma client, is bundled. Keeps the react-server condition (D-27).
import { readFileSync } from "node:fs";
import { build } from "esbuild";

await build({
  entryPoints: { main: "worker/main.ts", healthcheck: "worker/healthcheck.ts" },
  outdir: "dist/worker",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  packages: "external",
  conditions: ["react-server"],
  tsconfig: "tsconfig.json",
  sourcemap: true,
  logLevel: "info",
});
for (const file of ["dist/worker/main.mjs", "dist/worker/healthcheck.mjs"]) {
  if (/(from\s*|import\(\s*)["']@\//.test(readFileSync(file, "utf8"))) throw new Error(`${file}: an @/ alias was left unresolved`);
}
