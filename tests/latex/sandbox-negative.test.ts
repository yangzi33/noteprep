import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CompileError } from "@/lib/latex/compiler";
import { DEFAULT_SANDBOX } from "@/lib/latex/sandbox";
import { readTar, TarError, writeTar } from "@/lib/latex/tar";
import { compileRaw, compiler, config, leftoverContainers, minimalTex, pdfText, probe } from "./helpers";

const fails = async (p: Promise<unknown>) => (await p.then(() => null, (e) => e)) as CompileError;
const settled = async () => {
  for (let i = 0; i < 30; i++) {
    if ((await leftoverContainers()).length === 0) return [];
    await new Promise((r) => setTimeout(r, 200));
  }
  return leftoverContainers();
};

/** These run ARBITRARY code inside the container with the exact production restrictions: what a compromised TeX could do. */
describe("what code inside the sandbox cannot do", () => {
  const canary = `canary-${Math.random().toString(36).slice(2)}`;
  let hostFile: string;
  beforeAll(() => {
    process.env.LLM_API_KEY = canary;
    process.env.WORKER_DATABASE_URL = `postgres://${canary}`;
    process.env.STRIPE_SECRET_KEY = canary;
    hostFile = path.join(mkdtempSync(path.join(os.tmpdir(), "host-secret-")), "secret.txt");
    writeFileSync(hostFile, canary);
  });
  afterAll(() => {
    delete process.env.LLM_API_KEY;
    delete process.env.WORKER_DATABASE_URL;
    delete process.env.STRIPE_SECRET_KEY;
    rmSync(path.dirname(hostFile), { recursive: true, force: true });
  });

  it("has no network: connections fail and only loopback exists", async () => {
    const connect = await probe("bash -c 'exec 3<>/dev/tcp/1.1.1.1/53' 2>&1; echo exit=$?");
    expect(connect.stdout).not.toContain("exit=0");
    const resolve = await probe("bash -c 'exec 3<>/dev/tcp/example.com/80' 2>&1; echo exit=$?");
    expect(resolve.stdout).not.toContain("exit=0");
    const interfaces = await probe("ls /sys/class/net");
    expect(interfaces.stdout.trim()).toBe("lo");
  });

  it("has its limits applied by the kernel, not just requested (rootless Docker without cgroup delegation drops them)", async () => {
    const p = await probe("cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.swap.max /sys/fs/cgroup/pids.max /sys/fs/cgroup/cpu.max");
    expect(p.exitCode, p.stderr).toBe(0);
    const [memory, swap, pids, cpu] = p.stdout.trim().split("\n");
    expect(Number(memory)).toBe(DEFAULT_SANDBOX.memoryMb * 1024 * 1024);
    expect(swap).toBe("0");
    expect(Number(pids)).toBe(DEFAULT_SANDBOX.pidsLimit);
    expect(cpu).toBe(`${DEFAULT_SANDBOX.cpus * 100_000} 100000`);
  });

  it("cannot write anywhere except its small scratch directory, and cannot run anything from it", async () => {
    const p = await probe(`
      touch /etc/x 2>/dev/null && echo etc=WRITABLE || echo etc=denied
      touch /usr/x 2>/dev/null && echo usr=WRITABLE || echo usr=denied
      touch /tmp/x 2>/dev/null && echo tmp=WRITABLE || echo tmp=denied
      touch /work/ok 2>/dev/null && echo work=writable || echo work=DENIED
      cp /bin/true /work/t 2>/dev/null; /work/t 2>/dev/null && echo exec=RAN || echo exec=denied`);
    expect(p.stdout).toContain("etc=denied");
    expect(p.stdout).toContain("usr=denied");
    expect(p.stdout).toContain("tmp=denied");
    expect(p.stdout).toContain("work=writable");
    expect(p.stdout).toContain("exec=denied");
  });

  it("runs unprivileged: no capabilities, no new privileges, a seccomp filter, and no mount or namespace tricks", async () => {
    const p = await probe(`id -u; grep -E '^(CapInh|CapPrm|CapEff|CapBnd|CapAmb):' /proc/self/status; grep -E '^(NoNewPrivs|Seccomp):' /proc/self/status
      mount -t tmpfs none /mnt 2>/dev/null && echo mount=ALLOWED || echo mount=denied
      unshare -r true 2>/dev/null && echo userns=ALLOWED || echo userns=denied
      chroot /tmp true 2>/dev/null && echo chroot=ALLOWED || echo chroot=denied`);
    expect(p.stdout.split("\n")[0]).toBe("65534");
    for (const line of p.stdout.split("\n").filter((l) => /^Cap/.test(l))) expect(line, line).toMatch(/:\s+0000000000000000$/);
    expect(p.stdout).toMatch(/NoNewPrivs:\s+1/);
    expect(p.stdout).toMatch(/Seccomp:\s+2/);
    expect(p.stdout).toContain("mount=denied");
    expect(p.stdout).toContain("userns=denied");
    expect(p.stdout).toContain("chroot=denied");
  });

  it("sees nothing of the host: no Docker socket, no host mounts, no host files", async () => {
    const p = await probe(`ls /var/run/docker.sock /run/docker.sock 2>&1 | head -2
      grep -E ' (/mnt|/home|/run/docker|/var/run) ' /proc/mounts || echo no-host-mounts
      find / -xdev -name secret.txt -path '*host-secret*' 2>/dev/null | head -1; echo done`);
    expect(p.stdout).not.toMatch(/docker\.sock$/m);
    expect(p.stdout).toContain("no-host-mounts");
    expect(p.stdout).not.toContain("host-secret");
  });

  it("inherits none of the worker's environment: no database, storage, billing or model credentials", async () => {
    const p = await probe(`env; echo ---; cat /proc/1/environ 2>/dev/null | tr '\\0' '\\n'; echo ---; cat /proc/self/environ 2>/dev/null | tr '\\0' '\\n'; echo done`);
    expect(p.stdout).not.toContain(canary);
    expect(p.stdout).not.toMatch(/LLM_API_KEY|WORKER_DATABASE_URL|STRIPE_SECRET_KEY/);
    expect(p.stdout).toContain("done");
  });

  it("cannot fork without bound: the process limit holds", async () => {
    const p = await probe(`perl -e '$n=0; for (1..400) { my $pid = fork(); if (!defined $pid) { last } if ($pid == 0) { sleep 20; exit } $n++ } print "forked=$n\\n"; kill 9, -$$' 2>&1; true`, { wallClockMs: 30_000 });
    const forked = Number(/forked=(\d+)/.exec(p.stdout)?.[1] ?? NaN);
    expect(forked).toBeGreaterThan(5);
    expect(forked).toBeLessThanOrEqual(64);
  });

  it("cannot use more memory than its limit", async () => {
    const p = await probe(`perl -e '$x = "a" x 1_500_000_000; print "allocated\\n"' 2>&1; echo exit=$?`, { memoryMb: 256 });
    expect(p.stdout).not.toContain("allocated");
    expect(p.stdout).toMatch(/exit=(1|137)|Out of memory|Killed/);
  });

  it("cannot fill the disk: file size and scratch space are both capped", async () => {
    const p = await probe(`dd if=/dev/zero of=/work/big bs=1M count=200 2>&1; echo exit=$?; ls -l /work/big | awk '{print "size="$5}'`, { maxFileBytes: 5_000_000 });
    expect(p.stdout).not.toContain("exit=0");
    const size = Number(/size=(\d+)/.exec(p.stdout)?.[1] ?? Infinity);
    expect(size).toBeLessThanOrEqual(5_000_000);
  });

  it("is killed from outside at the wall-clock limit, even if it ignores every signal", async () => {
    const p = await probe(`trap '' TERM INT HUP; sleep 300`, { wallClockMs: 2_500 });
    expect(p.killedFor).toBe("timeout");
    expect(p.ms).toBeLessThan(10_000);
    expect(await settled()).toEqual([]);
  });

  it("is killed when it floods its output, and the flood is not buffered without bound", async () => {
    const p = await probe(`yes AAAAAAAAAAAAAAAA`, { maxStdoutBytes: 1_000_000, wallClockMs: 30_000 });
    expect(p.killedFor).toBe("stdout_limit");
    expect(p.stdout.length).toBeLessThanOrEqual(1_000_000);
    expect(p.ms).toBeLessThan(15_000);
    expect(await settled()).toEqual([]);
  });
});

/** Hostile SOURCE, given straight to the real entry script: the renderer would never emit any of it. */
describe("hostile TeX source", () => {
  it("cannot run a command: shell escape is off however it is asked", async () => {
    const attempts = [
      minimalTex("\\immediate\\write18{touch out/pwned.txt}"),
      minimalTex("\\input|\"touch out/pwned.txt\""),
      minimalTex("\\immediate\\write18{echo hi > out/pwned.txt}"),
      minimalTex("\\catcode`\\^^M=12 \\immediate\\write18{touch out/pwned.txt}"),
    ];
    for (const tex of attempts) {
      const r = await compileRaw({ "notes.tex": tex });
      expect([...r.byName.keys()].filter((n) => !/^notes\.(pdf|json|log)$/.test(n)), tex).toEqual([]);
      expect(r.byName.has("pwned.txt"), tex).toBe(false);
    }
  });

  it("cannot read files it should not: nothing outside the document reaches the PDF", async () => {
    const targets = ["/etc/passwd", "/proc/self/environ", "/etc/shadow", "../../etc/hostname", "/proc/1/cmdline"];
    for (const target of targets) {
      const tex = minimalTex(`\\newread\\f\\openin\\f=${target}\\ifeof\\f NOFILE\\else\\read\\f to\\l \\l\\fi`);
      const r = await compileRaw({ "notes.tex": tex });
      const pdf = r.byName.get("notes.pdf");
      const text = pdf ? await pdfText(pdf) : "";
      expect(text, target).not.toMatch(/root:|nobody:|HOME=|PATH=|noteprep-tex/);
    }
  });

  it("cannot write outside its working directory, nor even into the output directory", async () => {
    const attempts = {
      "evil.txt": [minimalTex("\\immediate\\openout3=/etc/evil.txt \\immediate\\write3{x}\\immediate\\closeout3"), minimalTex("\\immediate\\openout3=../../tmp/evil.txt \\immediate\\write3{x}\\immediate\\closeout3")],
      "extra.txt": [minimalTex("\\immediate\\openout3=out/extra.txt \\immediate\\write3{x}\\immediate\\closeout3 ok")],
    };
    for (const [file, sources] of Object.entries(attempts)) {
      for (const tex of sources) {
        const r = await compileRaw({ "notes.tex": tex });
        expect(r.byName.has(file), tex).toBe(false);
        expect(r.exitCode, tex).toBe(10); // TeX refuses ("I can't write on file ...") and the compile fails
      }
    }
  });

  it("whatever a compromised container writes into its output, the host's reader rejects links and strays (real GNU tar output)", async () => {
    const link = await probe("mkdir /work/out && ln -s /etc/passwd /work/out/notes.pdf && tar -cf - -C /work/out .");
    expect(() => readTar(Buffer.from(link.stdout, "latin1"), { maxEntries: 10, maxFileBytes: 1000, maxTotalBytes: 5000 })).toThrow(expect.objectContaining({ code: "not_a_regular_file" }));
    const nested = await probe("mkdir -p /work/out/sub && echo x > /work/out/sub/a.pdf && tar -cf - -C /work/out .");
    expect(() => readTar(Buffer.from(nested.stdout, "latin1"), { maxEntries: 10, maxFileBytes: 1000, maxTotalBytes: 5000 })).toThrow(TarError);
    const fine = await probe("mkdir /work/out && echo x > /work/out/notes.pdf && tar -cf - -C /work/out .");
    expect(readTar(Buffer.from(fine.stdout, "latin1"), { maxEntries: 10, maxFileBytes: 1000, maxTotalBytes: 5000 }).map((e) => e.name)).toEqual(["notes.pdf"]);
  });

  it("rejects an input name that tries to leave the directory before anything is started", () => {
    for (const name of ["../notes.tex", "/etc/notes.tex", "a/b.tex", "notes.tex\0.pdf"]) {
      expect(() => writeTar([{ name, data: new Uint8Array() }]), name).toThrow(TarError);
    }
  });

  it("an expansion bomb ends quickly in a compile failure, not a hang", async () => {
    const r = await compileRaw({ "notes.tex": minimalTex("\\def\\a{\\a\\a}\\a") }, { texTimeoutSeconds: 20 });
    expect(r.exitCode).toBe(10);
    expect(r.byName.has("notes.pdf")).toBe(false);
    expect(r.ms).toBeLessThan(25_000);
    expect(await settled()).toEqual([]);
  });

  it("an infinite loop is stopped by the per-document limit inside the container", async () => {
    const r = await compileRaw({ "notes.tex": minimalTex("\\def\\a{\\a}\\a") }, { texTimeoutSeconds: 3, wallClockMs: 30_000 });
    expect(r.exitCode).toBe(10);
    expect(r.killedFor).toBeNull(); // the container's own timeout acted first
    expect(r.ms).toBeLessThan(15_000);
    expect(await settled()).toEqual([]);
  });

  it("an infinite loop in a pack fails the whole pack with a retryable timeout when the outer limit is hit first", async () => {
    const error = await fails(compiler({ texTimeoutSeconds: 120, wallClockMs: 3_000 }).compile({ documents: [{ id: "notes", tex: minimalTex("\\def\\a{\\a}\\a") }] }));
    expect(error).toMatchObject({ code: "compile_timeout", retryable: true });
    expect(await settled()).toEqual([]);
  });

  it("a document with thousands of pages is rejected, not accepted and not allowed to run away", async () => {
    const tex = minimalTex("\\newcount\\n \\n=0 \\loop\\ifnum\\n<3000 \\null\\newpage \\advance\\n by 1 \\repeat");
    const error = await fails(compiler({ texTimeoutSeconds: 40, wallClockMs: 60_000 }).compile({ documents: [{ id: "notes", tex }] }));
    expect(error).toBeInstanceOf(CompileError);
    expect(error.code === "compile_failed" || error.code === "compile_timeout").toBe(true);
    expect(await settled()).toEqual([]);
  });

  it("a huge log is truncated before it leaves the container", async () => {
    const tex = minimalTex("\\newcount\\n \\n=0 \\loop\\ifnum\\n<20000 \\typeout{AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA}\\advance\\n by 1 \\repeat ok");
    const r = await compileRaw({ "notes.tex": tex });
    const log = r.byName.get("notes.log");
    expect(log).toBeDefined();
    expect(log!.byteLength).toBeLessThanOrEqual(20_000);
  });

  it("a PDF made to run JavaScript or an action when opened is rejected by the host", async () => {
    const hostile = [
      minimalTex("\\pdfcatalog{/OpenAction << /S /JavaScript /JS <616C657274283129> >>} text"),
      minimalTex("\\pdfannot width 1cm height 1cm {/Subtype /Link /A << /S /JavaScript /JS <616C657274283129> >>} text"),
      minimalTex("\\pdfannot width 1cm height 1cm {/Subtype /Link /A << /S /Launch /F (cmd.exe) >>} text"),
      // object compression turned back on to hide the dictionaries: refused because an object stream exists at all
      minimalTex("\\pdfobjcompresslevel=2 \\pdfcatalog{/OpenAction << /S /JavaScript /JS <78> >>} text"),
    ];
    for (const tex of hostile) {
      expect(await fails(compiler().compile({ documents: [{ id: "notes", tex }] })), tex).toMatchObject({ code: "compile_failed", detail: "notes: the PDF contains active content" });
    }
  });

  it("a document without the template's object-compression line is refused: compressed objects could hide a dictionary", async () => {
    const bare = "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n";
    expect(await fails(compiler().compile({ documents: [{ id: "notes", tex: bare }] }))).toMatchObject({ code: "compile_failed", detail: "notes: the PDF contains active content" });
  });

  it("a perfectly ordinary document still compiles (the checks are not trigger-happy)", async () => {
    const result = await compiler().compile({ documents: [{ id: "notes", tex: minimalTex("Hello, world. $x = 5$.") }] });
    expect(result[0]).toMatchObject({ id: "notes", pages: 1 });
  });
});

describe("the runner itself", () => {
  it("reports a missing image as the sandbox being unavailable (retryable), never pulling one from the network", async () => {
    const error = await fails(compiler({ image: "noteprep-latex:does-not-exist" }).compile({ documents: [{ id: "notes", tex: minimalTex("x") }] }));
    expect(error).toMatchObject({ code: "sandbox_unavailable", retryable: true });
  });

  it("reports a missing docker client as the sandbox being unavailable", async () => {
    const error = await fails(compiler({ docker: "/nonexistent/docker" }).compile({ documents: [{ id: "notes", tex: minimalTex("x") }] }));
    expect(error).toMatchObject({ code: "sandbox_unavailable", retryable: true });
  });

  it("stops promptly and cleans up when the caller cancels in the middle of a compile", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = compiler({ texTimeoutSeconds: 60 }).compile({ documents: [{ id: "notes", tex: minimalTex("\\def\\a{\\a}\\a") }], signal: controller.signal });
    setTimeout(() => controller.abort(), 1_500);
    await expect(pending).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(await settled()).toEqual([]);
  });

  it("compiles several packs at once without them interfering", async () => {
    const run = (word: string) => compiler().compile({ documents: [{ id: "notes", tex: minimalTex(`Pack ${word}`) }] });
    const results = await Promise.all(["alpha", "bravo", "charlie"].map(run));
    const texts = await Promise.all(results.map((r) => pdfText(r[0]!.pdf)));
    expect(texts.map((t) => /Pack (\w+)/.exec(t)?.[1])).toEqual(["alpha", "bravo", "charlie"]);
    expect(await settled()).toEqual([]);
  });

  it("uses a fresh container every time (nothing carries over between compilations)", async () => {
    const marker = await probe("echo leftover > /work/state.txt; echo written");
    expect(marker.stdout).toContain("written");
    const next = await probe("cat /work/state.txt 2>&1; ls -A /work | wc -l");
    expect(next.stdout).not.toContain("leftover");
  });
  void config;
});
