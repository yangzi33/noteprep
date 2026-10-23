import { runRecover } from "./recover-cli";

// Run with: pnpm worker:recover -- --revision <uuid> [--check]  (built: node --conditions=react-server dist/worker/recover.mjs ...)
runRecover(process.argv.slice(2)).then((code) => process.exit(code));
