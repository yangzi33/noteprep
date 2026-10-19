import { spawn } from "node:child_process";
import { DockerLatexCompiler } from "@/lib/latex/docker-compiler";
import { CONTAINER_PREFIX, DEFAULT_SANDBOX, dockerRunArgs, newContainerName, runContainer, type ContainerResult, type SandboxConfig } from "@/lib/latex/sandbox";
import { readTar, writeTar, type TarEntry } from "@/lib/latex/tar";

export const IMAGE = process.env.LATEX_IMAGE ?? "noteprep-latex:dev";

/** Production-strength settings, with the docker client environment these tests need (tests may read process.env). */
export function config(over: Partial<SandboxConfig> = {}): SandboxConfig {
  const keep = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "XDG_RUNTIME_DIR"];
  const clientEnv = Object.fromEntries(keep.flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]!]])));
  return { ...DEFAULT_SANDBOX, image: IMAGE, clientEnv, ...over };
}

export const compiler = (over: Partial<SandboxConfig> = {}) => new DockerLatexCompiler(config(over));

export interface Probe {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  killedFor: ContainerResult["killedFor"];
  ms: number;
}

/** Runs a shell command inside the container under EXACTLY the production restrictions (only the entrypoint differs). */
export async function probe(command: string, over: Partial<SandboxConfig> = {}, stdin: Uint8Array = new Uint8Array()): Promise<Probe> {
  const cfg = config(over);
  const name = newContainerName();
  const started = Date.now();
  const result = await runContainer(dockerRunArgs(cfg, name, ["sh", "-c", command]), stdin, { config: cfg, name });
  return { exitCode: result.exitCode, stdout: result.stdout.toString("utf8"), stderr: result.stderrHead, killedFor: result.killedFor, ms: Date.now() - started };
}

/** Feeds hand-written source straight to the image's real entry script, bypassing the renderer, and returns the archive. */
export async function compileRaw(files: Record<string, string>, over: Partial<SandboxConfig> = {}) {
  const cfg = config(over);
  const name = newContainerName();
  const started = Date.now();
  const entries: TarEntry[] = Object.entries(files).map(([n, text]) => ({ name: n, data: new TextEncoder().encode(text) }));
  const result = await runContainer(dockerRunArgs(cfg, name), writeTar(entries), { config: cfg, name });
  let out: TarEntry[] = [];
  try {
    out = readTar(result.stdout, { maxEntries: 50, maxFileBytes: 30_000_000, maxTotalBytes: 60_000_000 });
  } catch {
    /* an unreadable result is itself informative: the test asserts on the exit code */
  }
  return { ...result, out, byName: new Map(out.map((e) => [e.name, e.data])), ms: Date.now() - started };
}

/** Text of a PDF, extracted inside a sandbox container (never with host tools). */
export async function pdfText(pdf: Uint8Array): Promise<string> {
  const p = await probe("cat > /work/x.pdf && pdftotext -layout /work/x.pdf -", {}, pdf);
  if (p.exitCode !== 0) throw new Error(`pdftotext failed: ${p.stderr}`);
  return p.stdout;
}

/** Names of this project's compile containers that still exist (running or not). */
export function leftoverContainers(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["ps", "-a", "--filter", `name=${CONTAINER_PREFIX}`, "--format", "{{.Names}}"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", () => resolve(out.split("\n").filter(Boolean)));
  });
}

/**
 * A bare document for hostile-source tests. It starts with the same object-compression line as the real template: without
 * it pdfTeX writes object streams, which the host refuses on purpose (see hasActiveContent).
 */
export const minimalTex = (body: string) => `\\pdfobjcompresslevel=0\n\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
