import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { probe } from "./helpers";

describe("the compilation image", () => {
  it("contains exactly the pinned packages and TeX version (docker/latex/packages.lock)", async () => {
    const lock = readFileSync(path.join(__dirname, "../../docker/latex/packages.lock"), "utf8")
      .split("\n")
      .filter((l) => l && !l.startsWith("#"));
    const packages = lock.filter((l) => !l.startsWith("pdfTeX")).map((l) => l.split(" ")[0]!);
    const p = await probe(`dpkg-query -W -f='\${Package} \${Version}\\n' ${packages.join(" ")} | sort; pdflatex --version | head -1`);
    expect(p.exitCode).toBe(0);
    expect(p.stdout.trim().split("\n")).toEqual(lock);
  });

  it("runs as an unprivileged user in a throwaway working directory", async () => {
    const p = await probe("id -u; id -g; pwd");
    expect(p.stdout.trim().split("\n")).toEqual(["65534", "65534", "/work"]);
  });

  it("has no network tools and no credentials of any kind in its environment", async () => {
    const p = await probe("env | sort; which curl wget git ssh python3 nc 2>/dev/null; true");
    expect(p.stdout).not.toMatch(/KEY|SECRET|TOKEN|PASSWORD|DATABASE|SUPABASE|STRIPE|ANTHROPIC|LLM_/i);
    expect(p.stdout).not.toMatch(/\/(curl|wget|git|ssh|python3|nc)$/m);
  });

  it("has shell escape disabled in its TeX configuration", async () => {
    const p = await probe("kpsewhich -var-value shell_escape; kpsewhich -var-value openout_any; kpsewhich -var-value openin_any");
    expect(p.stdout.trim().split("\n")).toEqual(["f", "p", "p"]);
  });
});
