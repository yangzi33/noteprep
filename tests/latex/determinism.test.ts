import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { renderPackage } from "@/lib/latex/render";
import { dockerRunArgs, newContainerName, runContainer } from "@/lib/latex/sandbox";
import { readTar, writeTar } from "@/lib/latex/tar";
import { testPackage } from "../fixtures/package";
import { config } from "./helpers";

// Cross-host determinism (decision M-7): a PDF must depend only on the tex source and the pinned compile inputs, never on
// the host clock, time zone, hostname, container name or the worker's own paths. Each variant here runs the real
// entry script under the production restrictions with one ambient thing changed.
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function compileVariant(tex: string, extra: string[], pause = 0, dropEnv: string[] = []): Promise<Uint8Array> {
  if (pause) await new Promise((r) => setTimeout(r, pause));
  const cfg = config();
  const name = newContainerName();
  const args = dockerRunArgs(cfg, name).filter((a, i, all) => !(dropEnv.some((v) => a.startsWith(`${v}=`)) || (a === "--env" && dropEnv.some((v) => all[i + 1]!.startsWith(`${v}=`)))));
  args.splice(args.length - 1, 0, ...extra); // before the image reference
  const result = await runContainer(args, writeTar([{ name: "notes.tex", data: new TextEncoder().encode(tex) }]), { config: cfg, name });
  expect(result.exitCode).toBe(0);
  const out = readTar(result.stdout, { maxEntries: 50, maxFileBytes: 30_000_000, maxTotalBytes: 60_000_000 });
  return out.find((e) => e.name === "notes.pdf")!.data;
}

describe("PDF determinism across hosts", () => {
  const tex = renderPackage(testPackage({}, "determinism")).find((d) => d.id === "notes")!.tex;

  it("gives the same bytes with a different clock reading, time zone, locale, hostname and CPU limit", async () => {
    const base = await compileVariant(tex, []);
    // The 2.5 s pause moves the container's wall clock across at least two whole seconds; TZ and LANG change formatting.
    const other = await compileVariant(tex, ["--env", "TZ=Pacific/Auckland", "--env", "LANG=de_DE.UTF-8", "--env", "LC_ALL=C.UTF-8", "--hostname", "another-host"], 2500);
    expect(sha(other)).toBe(sha(base));
  }, 120_000);

  it("is the pinned SOURCE_DATE_EPOCH that removes the clock: without it two runs a few seconds apart differ", async () => {
    // Guards the premise of the test above: if this ever stops differing, the clock test proves nothing.
    const a = await compileVariant(tex, [], 0, ["SOURCE_DATE_EPOCH", "FORCE_SOURCE_DATE"]);
    const b = await compileVariant(tex, [], 2500, ["SOURCE_DATE_EPOCH", "FORCE_SOURCE_DATE"]);
    expect(sha(a)).not.toBe(sha(b));
  }, 120_000);

  it("embeds no host or container path, user name or hostname in the PDF", async () => {
    const pdf = Buffer.from(await compileVariant(tex, ["--hostname", "leak-check-host"])).toString("latin1");
    for (const needle of [process.cwd(), tmpdir(), process.env.HOME ?? "/home/", "/home/", "leak-check-host", "noteprep-tex-", "/work/"]) {
      expect(pdf, needle).not.toContain(needle);
    }
  }, 120_000);
});
