import { checkLiveness } from "./liveness";
// Container HEALTHCHECK: node dist/worker/healthcheck.mjs <file> <maxAgeSeconds>. Exit 0 = alive.
const [file, maxAge] = process.argv.slice(2);
const seconds = Number(maxAge);
process.exit(file && Number.isInteger(seconds) && seconds > 0 && checkLiveness(file, seconds) ? 0 : 1);
