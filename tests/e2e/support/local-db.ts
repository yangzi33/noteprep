/**
 * The E2E global setup edits rows directly on the owner connection. Refuse to do that anywhere but a local database.
 * Local means: loopback, or the Docker host alias used from containers.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "host.docker.internal"]);

export function assertLocalDatabase(connectionString: string): void {
  let host: string;
  try {
    host = new URL(connectionString).hostname.toLowerCase();
  } catch {
    throw new Error("The e2e database URL could not be parsed; refusing to run the e2e cleanup.");
  }
  if (!LOCAL_HOSTS.has(host)) throw new Error(`The e2e setup edits rows directly and only runs against a local database; "${host}" is not local.`);
}
