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
              group: ["@prisma/client", "@prisma/client/*", "@prisma/adapter-*", "**/generated/prisma", "**/generated/prisma/*"],
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
    // The data access layer and the db module that builds the client may import it; so may tests.
    files: [DAL_GLOB, "src/lib/server/db.ts", "tests/**"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    // Tooling and tests configure themselves from the environment.
    files: ["tests/**", "prisma7.config.ts", "*.config.mts"],
    rules: { "no-restricted-properties": "off" },
  },
  {
    files: ENV_FILES,
    rules: { "no-restricted-properties": "off" },
  },
  globalIgnores(["src/generated/**", ".next/**", "out/**", "build/**", "coverage/**", "next-env.d.ts"]),
]);

export default eslintConfig;
