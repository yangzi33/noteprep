import type { NextConfig } from "next";
import { assertTesterDeploy } from "./src/lib/server/tester-deploy";

// Fails `next build` and `next start` when a deploy marked NOTEPREP_TESTER_DEPLOY=1 lacks the contact address or the confirmed mail sender.
assertTesterDeploy(process.env);

const nextConfig: NextConfig = {
  poweredByHeader: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
