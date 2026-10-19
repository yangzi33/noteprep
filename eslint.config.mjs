import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Boundary rules from docs/architecture.md section 3:
// - only the data access layer may import the database client;
// - process.env is read only in the env modules.
const DAL_GLOB = "src/lib/server/dal/**";
const ENV_FILES = ["src/lib/server/env.ts", "worker/env.ts"];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@prisma/client", "@prisma/client/*", "@prisma/adapter-*"],
              message: "Import the database client only inside src/lib/server/dal.",
            },
          ],
        },
      ],
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message: "Read environment variables only in src/lib/server/env.ts or worker/env.ts.",
        },
      ],
    },
  },
  {
    files: [DAL_GLOB],
    rules: { "no-restricted-imports": "off" },
  },
  {
    files: ENV_FILES,
    rules: { "no-restricted-properties": "off" },
  },
  globalIgnores([".next/**", "out/**", "build/**", "coverage/**", "next-env.d.ts"]),
]);

export default eslintConfig;
