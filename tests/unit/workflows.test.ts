import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// Tripwire for CI supply-chain and permission rules (CLAUDE.md section 12). It asserts on the PARSED structure, so
// comments, quoting, flow style and trailing comments cannot hide or fake a rule. Mutation fixtures below prove it.
const DIR = join(process.cwd(), ".github", "workflows");
const GUARD = "github.ref == 'refs/heads/main'";
const TOKEN = /secrets\s*(\.|\[\s*['"])GITHUB_TOKEN|github\s*(\.token\b|\[\s*['"]token['"])/i;
const SHA_USE = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;

type Doc = Record<string, unknown>;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every violation found in the given workflow texts (file name -> content). Empty means compliant. */
export function audit(texts: Record<string, string>): string[] {
  const bad: string[] = [];
  for (const [file, text] of Object.entries(texts)) {
    const doc = parse(text) as Doc;
    const jobs = isObj(doc.jobs) ? doc.jobs : {};

    // Permissions: nothing may be write/write-all except images.yml jobs.push packages: write.
    const checkPerms = (perms: unknown, where: string, job: string | null) => {
      if (perms === undefined) return;
      if (typeof perms === "string") {
        if (/write/i.test(perms)) bad.push(`${file}: ${where} permissions "${perms}"`);
        return;
      }
      if (!isObj(perms)) return void bad.push(`${file}: ${where} permissions has an unexpected shape`);
      for (const [k, v] of Object.entries(perms)) {
        if (String(v).trim().toLowerCase() !== "write") continue;
        if (!(file === "images.yml" && job === "push" && k === "packages")) bad.push(`${file}: ${where} ${k}: write`);
      }
    };
    checkPerms(doc.permissions, "workflow", null);
    if (JSON.stringify(doc.permissions) !== JSON.stringify({ contents: "read" })) bad.push(`${file}: top-level permissions must be exactly contents: read`);
    for (const [name, job] of Object.entries(jobs)) if (isObj(job)) checkPerms(job.permissions, `job ${name}`, name);

    // Actions: pinned to a full commit SHA; no docker:// or unpinned local-looking refs.
    for (const [name, job] of Object.entries(jobs)) {
      if (!isObj(job)) continue;
      const steps = Array.isArray(job.steps) ? job.steps : [];
      const uses = [job.uses, ...steps.map((s) => (isObj(s) ? s.uses : undefined))].filter((u) => u !== undefined);
      for (const u of uses) if (typeof u !== "string" || !SHA_USE.test(u)) bad.push(`${file}: job ${name} unpinned action ${String(u)}`);
    }

    // The registry token: only the push job's "Log in to GHCR" step env, never anywhere else (any spelling).
    const walk = (node: unknown, path: string[]) => {
      if (typeof node === "string") {
        const atLogin =
          file === "images.yml" && path[0] === "jobs" && path[1] === "push" && path[2] === "steps" && path[4] === "env" &&
          path.length === 6 && isObj(jobs.push) && isObj((jobs.push.steps as unknown[])[Number(path[3])]) &&
          ((jobs.push.steps as Doc[])[Number(path[3])]!.name === "Log in to GHCR");
        if (TOKEN.test(node) && !atLogin) bad.push(`${file}: token reference at ${path.join(".")}`);
        // `secrets` as a whole object (toJSON(secrets), secrets: inherit style expressions) is never allowed.
        if (/\bsecrets\b(?!\s*\.\s*\w|\s*\[\s*['"])/.test(node)) bad.push(`${file}: whole secrets object at ${path.join(".")}`);
        // ci.yml has no secrets at all (its docker-socket justification depends on it); images.yml only the login token.
        if ((file === "ci.yml" || file === "images.yml") && /\bsecrets\b/.test(node) && !(atLogin && /^\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}$/.test(node.trim()))) {
          bad.push(`${file}: secrets reference at ${path.join(".")}`);
        }
      } else if (Array.isArray(node)) node.forEach((v, i) => walk(v, [...path, String(i)]));
      else if (isObj(node)) for (const [k, v] of Object.entries(node)) walk(v, [...path, k]);
    };
    walk(doc, []);

    // No privileged or chained triggers anywhere.
    const onAll = (doc as Doc).on ?? (doc as Doc)["true" as string];
    const trig = typeof onAll === "string" ? [onAll] : Array.isArray(onAll) ? onAll.map(String) : isObj(onAll) ? Object.keys(onAll) : [];
    for (const t of trig) if (t === "pull_request_target" || t === "workflow_run") bad.push(`${file}: forbidden trigger ${t}`);

    if (file === "images.yml") {
      // A final line without a trailing newline must still be processed.
      for (const [name, job] of Object.entries(jobs)) {
        const steps = isObj(job) && Array.isArray(job.steps) ? (job.steps as Doc[]) : [];
        for (const st of steps) {
          for (const m of typeof st.run === "string" ? st.run.matchAll(/while read [^\n]*/g) : []) {
            if (!/\|\| \[ -n "\$ref" \]; do/.test(m[0])) bad.push(`images.yml: job ${name} has a while read loop without the last-line guard`);
          }
        }
      }
      const on = (doc as Doc).on ?? (doc as Doc)["true" as string];
      const triggers = typeof on === "string" ? [on] : Array.isArray(on) ? on.map(String) : isObj(on) ? Object.keys(on) : [];
      if (triggers.join() !== "workflow_dispatch") bad.push(`images.yml: triggers are [${triggers.join()}]`);
      for (const n of ["build-test", "push"]) {
        const j = jobs[n];
        if (!isObj(j)) { bad.push(`images.yml: job ${n} missing`); continue; }
        if (typeof j.if !== "string" || j.if.trim() !== GUARD) bad.push(`images.yml: job ${n} lacks the job-level main guard`);
      }
      const push = jobs.push;
      if (isObj(push)) {
        if (JSON.stringify(push.permissions) !== JSON.stringify({ packages: "write" })) bad.push("images.yml: push permissions must be exactly packages: write");
        if (push.needs !== "build-test") bad.push("images.yml: push must need build-test");
        // Exact step allowlist: the only third-party code is the pinned download; the artifact is data, never executed.
        const steps = Array.isArray(push.steps) ? (push.steps as Doc[]) : [];
        const names = ["", "Load the tested images and verify their IDs", "Log in to GHCR", "Push and record digests read back from the registry", ""];
        if (steps.length !== 5) bad.push(`images.yml: push has ${steps.length} steps, expected 5`);
        steps.forEach((st, i) => {
          if (i === 0) {
            if (typeof st.uses !== "string" || !st.uses.startsWith("actions/download-artifact@")) bad.push("images.yml: push step 1 must be download-artifact");
          } else if (st.uses !== undefined) bad.push(`images.yml: push step ${i + 1} must not use an action`);
          if (names[i] && st.name !== names[i]) bad.push(`images.yml: push step ${i + 1} name changed`);
          if (typeof st.run === "string") {
            if (/\bpnpm\b|\bnpm\b|\bnode\b/.test(st.run)) bad.push("images.yml: push runs repository tooling");
            const rest = st.run.replaceAll("docker load -i out/images.tar", "").replaceAll("< out/images.txt", "").replace(/awk '[^']*' out\/images\.txt/g, "");
            if (/\bout\/|\.\/|\bsource\b|\beval\b/.test(rest)) bad.push(`images.yml: push step ${i + 1} touches the artifact beyond docker load / reading images.txt`);
          }
        });
        const load = steps[1]?.run;
        if (typeof load !== "string" || !load.includes("${GITHUB_REPOSITORY_OWNER,,}") || !load.includes("${GITHUB_SHA}")) {
          bad.push("images.yml: push must rebuild the expected refs from the owner and commit SHA");
        }
      }
      const bt = jobs["build-test"];
      if (isObj(bt) && JSON.stringify(bt.permissions) !== JSON.stringify({ contents: "read" })) bad.push("images.yml: build-test permissions must be exactly contents: read");
    }
  }
  return bad;
}

const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));
const real = Object.fromEntries(files.map((f) => [f, readFileSync(join(DIR, f), "utf8")]));
const mutate = (file: string, from: string | RegExp, to: string) => {
  const before = real[file]!;
  const after = before.replace(from, to);
  expect(after, `mutation anchor for ${file}`).not.toBe(before);
  return { ...real, [file]: after };
};

describe("workflows", () => {
  it("finds the workflow files", () => {
    expect(files).toEqual(expect.arrayContaining(["ci.yml", "images.yml"]));
  });

  it("the real workflows are compliant", () => {
    expect(audit(real)).toEqual([]);
  });

  it("ci.yml builds and tests the worker image", () => {
    const steps = JSON.stringify(parse(real["ci.yml"]!));
    expect(steps).toContain("pnpm worker:image");
    expect(steps).toContain("WORKER_IMAGE=noteprep-worker:dev pnpm test:image");
  });

  it("the push loops process an images.txt with no trailing newline", () => {
    const push = (parse(real["images.yml"]!) as { jobs: { push: { steps: Array<{ run?: string }> } } }).jobs.push;
    const loops = push.steps.flatMap((st) => [...(st.run ?? "").matchAll(/while read [^\n]*/g)].map((m) => m[0]));
    expect(loops).toHaveLength(2);
    const dir = mkdtempSync(join(tmpdir(), "images-txt-"));
    writeFileSync(join(dir, "images.txt"), "a:1 id1\nb:1 id2\nc:1 id3"); // no final newline
    for (const header of loops) {
      const script = `${header}\n echo "$ref"\ndone < images.txt`;
      const out = execFileSync("bash", ["-c", script], { cwd: dir, encoding: "utf8" });
      expect(out.trim().split("\n")).toEqual(["a:1", "b:1", "c:1"]);
    }
  });

  describe("mutations are caught", () => {
    const cases: Array<[string, Record<string, string>]> = [
      ["contents: write with a trailing comment", mutate("ci.yml", /^permissions:\n {2}contents: read/m, "permissions:\n  contents: write # x")],
      ["quoted 'write'", mutate("images.yml", /^ {6}packages: write$/m, "      packages: 'write'\n      contents: 'write'")],
      ["write-all at job level", mutate("ci.yml", /^ {4}timeout-minutes: 15$/m, "    timeout-minutes: 15\n    permissions: write-all")],
      ["flow-style { packages: write } in ci.yml", mutate("ci.yml", /^ {4}timeout-minutes: 15$/m, "    timeout-minutes: 15\n    permissions: { packages: write }")],
      ["while read loop without the last-line guard", mutate("images.yml", 'while read -r ref id || [ -n "$ref" ]; do', "while read -r ref id; do")],
      ["extra id-token: write in the push job", mutate("images.yml", /^ {6}packages: write$/m, "      packages: write\n      id-token: write")],
      ["commented-out guard", mutate("images.yml", /^ {4}if: github\.ref == 'refs\/heads\/main'\n( {4}runs-on: ubuntu-24\.04\n {4}timeout-minutes: 30)/m, "    # if: github.ref == 'refs/heads/main'\n$1")],
      ["added release trigger", mutate("images.yml", "  workflow_dispatch:\n", "  workflow_dispatch:\n  release:\n    types: [published]\n")],
      ["added push trigger as a list", mutate("images.yml", "on:\n  workflow_dispatch:\n", "on: [workflow_dispatch, push]\n")],
      ["github.token in an earlier step", mutate("images.yml", "      - run: corepack enable", "      - run: echo ${{ github.token }}\n      - run: corepack enable")],
      ["bracket-spelled token in ci.yml", mutate("ci.yml", "      - run: pnpm lint", "      - run: echo ${{ secrets['GITHUB_TOKEN'] }}\n      - run: pnpm lint")],
      ["token in the push job env", mutate("images.yml", "      - id: digests", "      - run: echo ${{ secrets.GITHUB_TOKEN }}\n      - id: digests")],
      ["unpinned action", mutate("images.yml", /actions\/download-artifact@[0-9a-f]{40}/, "actions/download-artifact@v7")],
      ["pull_request_target in ci.yml", mutate("ci.yml", /^ {2}pull_request:$/m, "  pull_request_target:")],
      ["workflow_run added to ci.yml", mutate("ci.yml", /^ {2}pull_request:$/m, "  pull_request:\n  workflow_run:\n    workflows: [x]")],
      ["secret added to ci.yml", mutate("ci.yml", "      - run: pnpm lint", "      - run: echo ${{ secrets.STRIPE_SECRET_KEY }}\n      - run: pnpm lint")],
      ["toJSON(secrets) in build-test", mutate("images.yml", "      - run: corepack enable", "      - run: echo ${{ toJSON(secrets) }}\n      - run: corepack enable")],
      ["secret other than the token in images.yml", mutate("images.yml", "      - run: corepack enable", "      - run: echo ${{ secrets.OTHER }}\n      - run: corepack enable")],
      ["extra pinned third-party action in push", mutate("images.yml", "      - name: Log in to GHCR", "      - uses: actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830\n      - name: Log in to GHCR")],
      ["push executes a script from the artifact", mutate("images.yml", "          docker load -i out/images.tar", "          bash out/run.sh\n          docker load -i out/images.tar")],
      ["push no longer rebuilds the expected refs", mutate("images.yml", /(artifact is data[^\n]*\n\s*)owner="\$\{GITHUB_REPOSITORY_OWNER,,\}"/, "$1owner=x")],
      ["push job checks out the repo", mutate("images.yml", "      - name: Load the tested images", "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n      - name: Load the tested images")],
    ];
    it.each(cases)("%s", (_name, texts) => {
      expect(audit(texts).length).toBeGreaterThan(0);
    });
  });
});
