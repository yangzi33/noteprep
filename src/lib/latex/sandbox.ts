import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { randomBytes } from "node:crypto";

/**
 * One container per compilation, started with every restriction CLAUDE.md section 8 asks for. The container gets no
 * network, no host mounts, no Docker socket, no environment from the worker (so no database, storage or model
 * credentials), a read-only root filesystem and a small tmpfs, no capabilities, no privilege escalation, a process
 * limit, memory and CPU limits, and a wall-clock limit enforced from outside. Input goes in over stdin and results come
 * back over stdout as tar archives: nothing is shared with the host.
 */
export interface SandboxConfig {
  /** Image reference. Production pins a digest; the tag is for local development. */
  image: string;
  docker: string;
  /** Host-side wall-clock limit for the whole container, after which it is killed and removed. */
  wallClockMs: number;
  /** Per-document limit inside the container (the entry script's `timeout`). */
  texTimeoutSeconds: number;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  workMb: number;
  /** Largest file the container may create (a ulimit), bytes. */
  maxFileBytes: number;
  /** Most bytes read from the container's stdout before it is killed. */
  maxStdoutBytes: number;
  /**
   * The environment of the Docker CLIENT process, and only that: the few variables it needs to find the daemon (PATH,
   * DOCKER_HOST, ...). Built by worker/env.ts, so none of the worker's own settings or secrets are ever inherited.
   */
  clientEnv: Record<string, string>;
}

export const DEFAULT_SANDBOX: Omit<SandboxConfig, "clientEnv"> = {
  image: "noteprep-latex:dev",
  docker: "docker",
  wallClockMs: 90_000,
  texTimeoutSeconds: 30,
  memoryMb: 512,
  cpus: 1,
  pidsLimit: 64,
  workMb: 64,
  maxFileBytes: 20_000_000,
  maxStdoutBytes: 30_000_000,
};

/** A fixed timestamp makes the PDFs reproducible: the same source gives the same bytes. */
export const SOURCE_DATE_EPOCH = "1704067200";

/** The container name prefix; cleanup and tests find leftovers by it. */
export const CONTAINER_PREFIX = "noteprep-tex-";

/**
 * The complete `docker run` argument list (no shell is ever involved). `entrypoint` replaces the image's fixed entry
 * script and exists only so tests can run probes under exactly these restrictions.
 */
export function dockerRunArgs(config: SandboxConfig, name: string, entrypoint?: string[]): string[] {
  return [
    "run",
    "--rm",
    "-i",
    "--name", name,
    "--pull", "never", // nothing is downloaded when a document is compiled
    "--network", "none",
    "--read-only",
    "--user", "65534:65534",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", String(config.pidsLimit),
    "--memory", `${config.memoryMb}m`,
    "--memory-swap", `${config.memoryMb}m`,
    "--cpus", String(config.cpus),
    "--ulimit", `fsize=${config.maxFileBytes}`,
    "--ulimit", "nofile=256",
    "--ulimit", "core=0",
    "--log-driver", "none",
    "--tmpfs", `/work:rw,noexec,nosuid,nodev,size=${config.workMb}m,uid=65534,gid=65534`,
    "--env", `SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}`,
    "--env", "FORCE_SOURCE_DATE=1",
    "--env", "HOME=/work",
    "--env", "TEXMFVAR=/work/.texmf-var",
    "--env", "TEXMFCONFIG=/work/.texmf-config",
    "--env", `TEX_TIMEOUT=${config.texTimeoutSeconds}`,
    ...(entrypoint ? ["--entrypoint", entrypoint[0]!] : []),
    config.image,
    ...(entrypoint ? entrypoint.slice(1) : []),
  ];
}

export interface ContainerResult {
  exitCode: number | null;
  stdout: Buffer;
  stderrHead: string;
  /** Why the worker killed the container, if it did. */
  killedFor: "timeout" | "aborted" | "stdout_limit" | null;
}

/** Next's type augmentation makes NODE_ENV mandatory on ProcessEnv; the Docker client does not need it. */
const clientProcessEnv = (config: SandboxConfig) => config.clientEnv as NodeJS.ProcessEnv;

/** Runs a docker command and forgets it: used for `kill` and `rm -f`, which must never block or throw. */
function fireAndForget(config: SandboxConfig, args: string[]): void {
  const child = spawn(config.docker, args, { stdio: "ignore", env: clientProcessEnv(config) });
  child.on("error", () => {});
}

export function newContainerName(): string {
  return `${CONTAINER_PREFIX}${randomBytes(8).toString("hex")}`;
}

/**
 * Runs one container to completion, feeding `stdin` and collecting stdout, with a wall-clock limit, an output limit and
 * cancellation. On any of those the container is killed and removed and the client's process group is killed too.
 */
export function runContainer(args: string[], stdin: Uint8Array, options: { config: SandboxConfig; name: string; signal?: AbortSignal }): Promise<ContainerResult> {
  const { config, name, signal } = options;
  return new Promise((resolve, reject) => {
    const child: ChildProcessByStdio<Writable, Readable, Readable> = spawn(config.docker, args, { detached: true, stdio: ["pipe", "pipe", "pipe"], env: clientProcessEnv(config) });
    const chunks: Buffer[] = [];
    let total = 0;
    let stderrHead = "";
    let killedFor: ContainerResult["killedFor"] = null;
    let settled = false;

    const kill = (reason: NonNullable<ContainerResult["killedFor"]>) => {
      if (killedFor) return;
      killedFor = reason;
      // The container first (that is what must stop), then the client that is attached to it.
      fireAndForget(config, ["kill", name]);
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    };

    const timer = setTimeout(() => kill("timeout"), config.wallClockMs);
    const onAbort = () => kill("aborted");
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > config.maxStdoutBytes) {
        kill("stdout_limit");
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrHead.length < 4000) stderrHead += chunk.toString("utf8").slice(0, 4000 - stderrHead.length);
    });
    child.stdin.on("error", () => {}); // the container may exit before reading everything
    child.stdin.end(Buffer.from(stdin));

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // --rm normally removes it; this covers a client that was killed before the daemon finished.
      if (killedFor) fireAndForget(config, ["rm", "-f", name]);
      resolve({ exitCode, stdout: Buffer.concat(chunks), stderrHead, killedFor });
    };
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => finish(code));
  });
}
