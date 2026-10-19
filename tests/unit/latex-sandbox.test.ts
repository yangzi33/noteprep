import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CompileError } from "@/lib/latex/compiler";
import { diagnose, DockerLatexCompiler, hasActiveContent, inspectPdf } from "@/lib/latex/docker-compiler";
import { CONTAINER_PREFIX, DEFAULT_SANDBOX, dockerRunArgs, type SandboxConfig } from "@/lib/latex/sandbox";
import { readTar, TarError, writeTar } from "@/lib/latex/tar";

const LIMITS = { maxEntries: 10, maxFileBytes: 1_000, maxTotalBytes: 3_000 };
const bytes = (s: string) => new TextEncoder().encode(s);

/** Builds one raw 512-byte header, so hostile archives can be made that writeTar would never produce. */
function rawHeader(o: { name: string; type?: string; size?: number; prefix?: string; checksum?: "bad"; sizeField?: string }): Uint8Array {
  const h = new Uint8Array(512);
  const put = (at: number, s: string) => h.set(new TextEncoder().encode(s), at);
  put(0, o.name);
  put(100, "0000644\0");
  put(124, o.sizeField ?? `${(o.size ?? 0).toString(8).padStart(11, "0")}\0`);
  put(148, "        ");
  put(156, o.type ?? "0");
  put(257, "ustar\0");
  if (o.prefix) put(345, o.prefix);
  let sum = 0;
  for (const b of h) sum += b;
  put(148, o.checksum === "bad" ? "0000000\0" : `${sum.toString(8).padStart(6, "0")}\0 `);
  return h;
}
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
};
const pad = (data: Uint8Array) => concat(data, new Uint8Array((512 - (data.byteLength % 512)) % 512));
const END = new Uint8Array(1024);
const file = (name: string, content: string, extra: Parameters<typeof rawHeader>[0] = { name }) => concat(rawHeader({ ...extra, name, size: content.length }), pad(bytes(content)));

describe("the tar reader accepts plain files and nothing else", () => {
  it("round-trips what the writer produces, deterministically", () => {
    const entries = [{ name: "notes.tex", data: bytes("hello") }, { name: "worksheet.tex", data: new Uint8Array(1500).fill(7) }];
    const archive = writeTar(entries);
    expect(readTar(archive, { ...LIMITS, maxFileBytes: 2000, maxTotalBytes: 5000 })).toEqual(entries);
    expect(writeTar(entries)).toEqual(archive);
  });
  it("accepts the root entry and ./ names that GNU tar writes", () => {
    const archive = concat(rawHeader({ name: "./", type: "5" }), file("./a.pdf", "x"), END);
    expect(readTar(archive, LIMITS).map((e) => e.name)).toEqual(["a.pdf"]);
  });
  it.each([
    ["a symlink", () => concat(rawHeader({ name: "a.pdf", type: "2" }), END), "not_a_regular_file"],
    ["a hard link", () => concat(rawHeader({ name: "a.pdf", type: "1" }), END), "not_a_regular_file"],
    ["a subdirectory", () => concat(rawHeader({ name: "sub/", type: "5" }), END), "not_a_regular_file"],
    ["a device", () => concat(rawHeader({ name: "a.pdf", type: "3" }), END), "not_a_regular_file"],
    ["a pax header", () => concat(rawHeader({ name: "pax", type: "x", size: 0 }), END), "not_a_regular_file"],
    ["a GNU long name", () => concat(rawHeader({ name: "././@LongLink", type: "L", size: 0 }), END), "not_a_regular_file"],
    ["a parent path", () => concat(file("../etc/passwd", "x"), END), "bad_name"],
    ["an absolute path", () => concat(file("/etc/passwd", "x"), END), "bad_name"],
    ["a nested path", () => concat(file("a/b.pdf", "x"), END), "bad_name"],
    ["a dot name", () => concat(file("..", "x"), END), "bad_name"],
    ["a 65 character name", () => concat(file("a".repeat(65), "x"), END), "bad_name"],
    ["a name with a space", () => concat(file("a b.pdf", "x"), END), "bad_name"],
    ["a ustar prefix", () => concat(file("a.pdf", "x", { name: "a.pdf", prefix: "deep/dir" }), END), "long_name"],
    ["a duplicate name", () => concat(file("a.pdf", "x"), file("a.pdf", "y"), END), "duplicate_name"],
    ["a bad checksum", () => concat(rawHeader({ name: "a.pdf", size: 1, checksum: "bad" }), pad(bytes("x")), END), "bad_checksum"],
    ["a size that is not octal", () => concat(rawHeader({ name: "a.pdf", sizeField: "99999999999\0" }), END), "bad_number"],
    ["a file over the limit", () => concat(file("a.pdf", "x".repeat(1001)), END), "file_too_large"],
    ["a total over the limit", () => concat(file("a.pdf", "x".repeat(900)), file("b.pdf", "x".repeat(900)), file("c.pdf", "x".repeat(900)), file("d.pdf", "x".repeat(900)), END), "output_too_large"],
    ["too many entries", () => concat(...Array.from({ length: 11 }, (_, i) => file(`f${i}.pdf`, "x")), END), "too_many_entries"],
    ["a truncated archive", () => concat(rawHeader({ name: "a.pdf", size: 600 }), bytes("short")), "truncated"],
    ["a directory that claims content", () => concat(rawHeader({ name: "./", type: "5", size: 5 }), END), "bad_directory"],
  ])("rejects %s", (_name, make, code) => {
    expect(() => readTar(make(), LIMITS)).toThrow(expect.objectContaining({ name: "TarError", code }));
  });
  it("refuses to write a name that is not flat", () => {
    for (const name of ["../x", "a/b", "/abs", "", "a b"]) expect(() => writeTar([{ name, data: bytes("x") }])).toThrow(TarError);
  });
});

describe("the container's restrictions", () => {
  const args = dockerRunArgs({ ...DEFAULT_SANDBOX, clientEnv: {} }, `${CONTAINER_PREFIX}abc`);
  const has = (...seq: string[]) => args.some((_, i) => seq.every((s, j) => args[i + j] === s));
  it("starts with every restriction CLAUDE.md asks for", () => {
    expect(has("--network", "none")).toBe(true);
    expect(args).toContain("--read-only");
    expect(has("--user", "65534:65534")).toBe(true);
    expect(has("--cap-drop", "ALL")).toBe(true);
    expect(has("--security-opt", "no-new-privileges")).toBe(true);
    expect(has("--pull", "never")).toBe(true);
    expect(has("--pids-limit", "64")).toBe(true);
    expect(has("--memory", "512m")).toBe(true);
    expect(has("--memory-swap", "512m")).toBe(true);
    expect(has("--cpus", "1")).toBe(true);
    expect(args.some((a) => a.startsWith("fsize="))).toBe(true);
    expect(args.find((a) => a.startsWith("/work:"))).toMatch(/noexec,nosuid,nodev,size=64m/);
    expect(has("--name", `${CONTAINER_PREFIX}abc`)).toBe(true);
  });
  it("shares nothing with the host", () => {
    const text = args.join(" ");
    for (const forbidden of ["-v ", "--volume", "--mount", "--privileged", "docker.sock", "--network host", "--ipc", "--device", "--cap-add", "--security-opt seccomp=unconfined"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    expect(text).not.toMatch(/--pid(=| |$)/); // --pids-limit is fine; sharing the host's PID namespace is not
    expect(args.filter((a) => a === "--env").length).toBe(6); // a fixed list, none inherited
  });
  it("puts an entrypoint override before the image only for probes, and keeps the image last otherwise", () => {
    const probe = dockerRunArgs({ ...DEFAULT_SANDBOX, clientEnv: {} }, "n", ["sh", "-c", "id"]);
    expect(probe[probe.indexOf("--entrypoint") + 1]).toBe("sh");
    expect(probe.slice(-3)).toEqual(["noteprep-latex:dev", "-c", "id"]);
    expect(probe.indexOf("noteprep-latex:dev")).toBeGreaterThan(probe.indexOf("--entrypoint"));
    expect(args.at(-1)).toBe("noteprep-latex:dev");
  });
});

describe("what the compiler trusts from the container", () => {
  let dir: string;
  let config: SandboxConfig;
  const log = () => (existsSync(path.join(dir, "calls.log")) ? readFileSync(path.join(dir, "calls.log"), "utf8") : "");

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "fake-docker-"));
    // A stand-in for the docker client: records every call and its environment, prints a prepared archive, exits as told.
    writeFileSync(
      path.join(dir, "docker"),
      `#!/bin/sh
echo "$@" >> "$FAKE_DIR/calls.log"
env > "$FAKE_DIR/env.dump"
case "$1" in kill|rm) exit 0;; esac
cat > /dev/null &
case "$FAKE_MODE" in
  sleep) sleep 30; exit 0;;
  flood) yes | head -c 3000000; exit 0;;
  *) cat "$FAKE_DIR/out.tar"; exit "\${FAKE_EXIT:-0}";;
esac
`,
    );
    chmodSync(path.join(dir, "docker"), 0o755);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const setup = (env: Record<string, string> = {}, over: Partial<SandboxConfig> = {}) => {
    rmSync(path.join(dir, "calls.log"), { force: true });
    config = { ...DEFAULT_SANDBOX, docker: path.join(dir, "docker"), clientEnv: { PATH: "/usr/bin:/bin", FAKE_DIR: dir, ...env }, ...over };
    return new DockerLatexCompiler(config);
  };
  const out = (...entries: [string, Uint8Array | string][]) => writeFileSync(path.join(dir, "out.tar"), writeTar(entries.map(([name, data]) => ({ name, data: typeof data === "string" ? bytes(data) : data }))));
  const pdf = (extra = "", pageCount = 1) =>
    bytes(`%PDF-1.5\n1 0 obj\n<< /Type /Catalog >>\nendobj\n${Array.from({ length: pageCount }, (_, i) => `${10 + i} 0 obj\n<< /Type /Page /Parent 1 0 R >>\nendobj\n`).join("")}${extra}\n%%EOF\n`);
  const doc = { id: "notes" as const, tex: "x" };
  const good = () => out(["notes.pdf", pdf("", 2)], ["notes.json", '{"pages":2}\n'], ["notes.log", "ok"]);
  const fails = async (p: Promise<unknown>) => (await p.then(() => null, (e) => e)) as CompileError;

  it("returns the PDFs and page counts when everything checks out", async () => {
    good();
    const result = await setup().compile({ documents: [doc] });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "notes", pages: 2 });
    expect(Buffer.from(result[0]!.pdf).toString("latin1").startsWith("%PDF-1.5")).toBe(true);
  });
  it("passes only the Docker client's own environment to it, never the worker's secrets", async () => {
    process.env.LLM_API_KEY = "canary-llm-key";
    process.env.WORKER_DATABASE_URL = "postgres://canary";
    try {
      good();
      await setup().compile({ documents: [doc] });
      const dump = readFileSync(path.join(dir, "env.dump"), "utf8");
      expect(dump).not.toContain("canary");
      expect(dump).toContain("FAKE_DIR=");
    } finally {
      delete process.env.LLM_API_KEY;
      delete process.env.WORKER_DATABASE_URL;
    }
  });
  it("turns a failed compile into a short redacted reason and no log text", async () => {
    out(["notes.log", "This is pdfTeX\n(/work/in/notes.tex\nin/notes.tex:12: Undefined control sequence $HOME/secret.\n"]);
    const error = await fails(setup({ FAKE_EXIT: "10" }).compile({ documents: [doc] }));
    expect(error).toBeInstanceOf(CompileError);
    expect(error).toMatchObject({ code: "compile_failed", retryable: false });
    expect(error.detail).toBe("notes: line 12: Undefined control sequence HOMEsecret.");
    expect(error.detail).not.toMatch(/\/work|\/in\//);
  });
  it("treats a docker client failure as the sandbox being unavailable (retryable), not as the document's fault", async () => {
    out();
    for (const code of ["125", "126", "127"]) expect(await fails(setup({ FAKE_EXIT: code }).compile({ documents: [doc] }))).toMatchObject({ code: "sandbox_unavailable", retryable: true });
  });
  it("kills and removes the container at the wall-clock limit", async () => {
    const error = await fails(setup({ FAKE_MODE: "sleep" }, { wallClockMs: 300 }).compile({ documents: [doc] }));
    expect(error).toMatchObject({ code: "compile_timeout", retryable: true });
    await new Promise((r) => setTimeout(r, 200));
    expect(log()).toMatch(new RegExp(`kill ${CONTAINER_PREFIX}[0-9a-f]{16}`));
    expect(log()).toMatch(new RegExp(`rm -f ${CONTAINER_PREFIX}[0-9a-f]{16}`));
  });
  it("kills the container when output floods past the limit", async () => {
    const error = await fails(setup({ FAKE_MODE: "flood" }, { maxStdoutBytes: 100_000 }).compile({ documents: [doc] }));
    expect(error).toMatchObject({ code: "compile_failed", detail: "the compiler produced too much output" });
    await new Promise((r) => setTimeout(r, 200));
    expect(log()).toMatch(/kill noteprep-tex-/);
  });
  it("stops when the caller cancels, and removes the container", async () => {
    const controller = new AbortController();
    const pending = setup({ FAKE_MODE: "sleep" }).compile({ documents: [doc], signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    await expect(pending).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 200));
    expect(log()).toMatch(/kill noteprep-tex-/);
  });
  it.each([
    ["an unexpected file", () => out(["notes.pdf", pdf()], ["notes.json", '{"pages":1}'], ["evil.sh", "#!/bin/sh"]), "the compiler returned an unexpected file"],
    ["a result that is not a PDF", () => out(["notes.pdf", "SKELETON - NOT A COMPILED PDF"], ["notes.json", '{"pages":1}']), "notes: the result is not a PDF"],
    ["a PDF with no trailer", () => out(["notes.pdf", "%PDF-1.5\nbody"], ["notes.json", '{"pages":1}']), "notes: the result is not a PDF"],
    ["a missing page count", () => out(["notes.pdf", pdf()]), "notes: no PDF was produced"],
    ["a garbage page count", () => out(["notes.pdf", pdf()], ["notes.json", '{"pages":"many"}']), "notes: unreadable page count"],
    ["a zero page count", () => out(["notes.pdf", pdf()], ["notes.json", '{"pages":0}']), "notes: unreadable page count"],
    ["too many pages", () => out(["notes.pdf", pdf("", 41)], ["notes.json", '{"pages":41}']), "notes: too many pages"],
    ["a container that under-reports the pages", () => out(["notes.pdf", pdf("", 3)], ["notes.json", '{"pages":1}']), "notes: the page count does not match the PDF"],
    ["a container that over-reports the pages", () => out(["notes.pdf", pdf("", 1)], ["notes.json", '{"pages":2}']), "notes: the page count does not match the PDF"],
    ["a PDF of 10000 pages reported as one", () => out(["notes.pdf", pdf("", 10000)], ["notes.json", '{"pages":1}']), "notes: too many pages"],
    ["a PDF with no page at all", () => out(["notes.pdf", bytes("%PDF-1.5\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n")], ["notes.json", '{"pages":1}']), "notes: the page count does not match the PDF"],
    ["JavaScript in the PDF", () => out(["notes.pdf", pdf("2 0 obj\n<< /S /JavaScript /JS (app.alert(1)) >>\nendobj")], ["notes.json", '{"pages":1}']), "notes: the PDF contains active content"],
    ["an open action", () => out(["notes.pdf", pdf("<< /OpenAction 5 0 R >>")], ["notes.json", '{"pages":1}']), "notes: the PDF contains active content"],
    ["a launch action", () => out(["notes.pdf", pdf("<< /S /Launch /F (cmd.exe) >>")], ["notes.json", '{"pages":1}']), "notes: the PDF contains active content"],
    ["hidden object streams", () => out(["notes.pdf", pdf("3 0 obj\n<< /Type /ObjStm /N 1 >>\nstream\nxx\nendstream\nendobj")], ["notes.json", '{"pages":1}']), "notes: the PDF contains active content"],
  ])("rejects %s", async (_name, make, detail) => {
    make();
    expect(await fails(setup().compile({ documents: [doc] }))).toMatchObject({ code: "compile_failed", retryable: false, detail });
  });
  it("rejects a hostile archive from the container: a symlink is an unusable result", async () => {
    writeFileSync(path.join(dir, "out.tar"), concat(rawHeader({ name: "notes.pdf", type: "2" }), END));
    expect(await fails(setup().compile({ documents: [doc] }))).toMatchObject({ code: "compile_failed", detail: "the compiler returned an unusable result" });
  });
  it("validates the request itself before starting anything", async () => {
    good();
    for (const documents of [[], [doc, doc], [{ id: "notes" as const, tex: "x".repeat(300_001) }], [{ id: "evil" as never, tex: "x" }]]) {
      expect(await fails(setup().compile({ documents })), JSON.stringify(documents).slice(0, 30)).toBeInstanceOf(CompileError);
    }
    expect(log()).toBe("");
  });
  it("needs every requested document, and fails the whole pack if one is bad", async () => {
    out(["notes.pdf", pdf()], ["notes.json", '{"pages":1}'], ["worksheet.log", "in/worksheet.tex:3: Missing $ inserted."]);
    const error = await fails(setup({ FAKE_EXIT: "10" }).compile({ documents: [doc, { id: "worksheet", tex: "x" }] }));
    expect(error).toMatchObject({ code: "compile_failed", detail: "worksheet: line 3: Missing inserted." });
  });
});

/** A hostile-PDF toolbox: every body here is built by hand, byte for byte. */
const raw = (body: string) => Buffer.from(`%PDF-1.5\n${body}\n%%EOF`, "latin1");
const ok = "1 0 obj\n<< /Type /Catalog >>\nendobj\n";
const stream = (data: string, dict = "") => `3 0 obj\n<< /Length ${data.length}${dict} >>\nstream\n${data}\nendstream\nendobj\n`;

describe("the PDF scan (hostile input)", () => {
  it("accepts a small benign PDF with a content stream", () => {
    const benign = raw(`${ok}2 0 obj\n<< /Type /Pages /Kids [4 0 R] /Count 1 >>\nendobj\n${stream("BT /F1 12 Tf (stream and endstream) Tj ET")}4 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 3 0 R >>\nendobj`);
    expect(inspectPdf(benign)).toEqual({ safe: true, pages: 1 });
  });
  it.each([
    ["a hex-escaped OpenAction", "<< /Type /Catalog /Open#41ction 5 0 R >>"],
    ["a hex-escaped JavaScript action", "<< /S /Java#53cript /J#53 (x) >>"],
    ["a fully escaped name", "<< /#4Aava#53cript (x) >>"],
    ["a Rendition action", "<< /S /Rendition >>"],
    ["a GoToE action", "<< /S /GoToE >>"],
    ["a Named action", "<< /S /Named /N /Print >>"],
    ["an AcroForm", "<< /AcroForm << /Fields [] >> >>"],
    ["XFA", "<< /XFA 5 0 R >>"],
    ["a Sound action", "<< /S /Sound >>"],
    ["a Movie action", "<< /S /Movie >>"],
    ["an embedded file", "<< /Type /Filespec /EF << /F 5 0 R >> /EmbeddedFile 5 0 R >>"],
    ["an EmbeddedFiles name tree", "<< /Names << /EmbeddedFiles 5 0 R >> >>"],
    ["a JavaScript name tree", "<< /Names << /JavaScript 5 0 R >> >>"],
    ["a URI action", "<< /S /URI /URI (http://x) >>"],
    ["an additional-actions entry", "<< /AA << /O 5 0 R >> >>"],
    ["a JS entry", "<< /JS (app.alert(1)) >>"],
    ["a SubmitForm action", "<< /S /SubmitForm >>"],
    ["a RichMedia annotation", "<< /Subtype /RichMedia >>"],
    ["an object stream", "<< /Type /ObjStm >>"],
  ])("rejects %s", (_name, dict) => {
    expect(hasActiveContent(raw(`${ok}5 0 obj\n${dict}\nendobj`))).toBe(true);
  });
  it("rejects a dictionary hidden between two string literals that look like stream and endstream", () => {
    expect(hasActiveContent(raw(`${ok}5 0 obj\n<< /X (stream\n) /OpenAction << /S /JavaScript /JS (x) >> /Y (endstream) >>\nendobj`))).toBe(true);
  });
  it("rejects a stream whose declared length does not end at endstream", () => {
    // Declares 4 bytes; the data goes on. A viewer would read 4 bytes and then see what follows as objects.
    expect(hasActiveContent(raw(`${ok}3 0 obj\n<< /Length 4 >>\nstream\nabcd /OpenAction\nendstream\nendobj`))).toBe(true);
    expect(hasActiveContent(raw(`${ok}3 0 obj\n<< /Length 400 >>\nstream\nabcd\nendstream\nendobj`))).toBe(true);
  });
  it("rejects a stream with no direct length", () => {
    expect(hasActiveContent(raw(`${ok}3 0 obj\n<< /Length 9 0 R >>\nstream\nabcd\nendstream\nendobj`))).toBe(true);
    expect(hasActiveContent(raw(`${ok}3 0 obj\n<< >>\nstream\nabcd\nendstream\nendobj`))).toBe(true);
  });
  it("rejects a stream that never ends", () => {
    expect(hasActiveContent(raw(`${ok}3 0 obj\n<< /Length 4 >>\nstream\nabcd`))).toBe(true);
  });
  it("rejects an unterminated string or hex string", () => {
    expect(hasActiveContent(raw(`${ok}5 0 obj\n(never closed`))).toBe(true);
    expect(hasActiveContent(raw(`${ok}5 0 obj\n<4142`))).toBe(true);
  });
  it("does not take a name inside a string or stream data for a name in the file", () => {
    expect(hasActiveContent(raw(`${ok}5 0 obj\n<< /T (/JavaScript /OpenAction) >>\nendobj\n${stream("/OpenAction /JavaScript")}`))).toBe(false);
  });
  it("counts page objects, not /Pages nodes, and sees escaped names", () => {
    expect(inspectPdf(raw(`${ok}2 0 obj\n<< /Type /Pages /Count 2 >>\nendobj\n4 0 obj\n<< /Type /Page >>\nendobj\n5 0 obj\n<< /Type/Pag#65 >>\nendobj`)).pages).toBe(2);
  });
});

describe("the PDF scan", () => {
  it("does not mistake random compressed bytes for active content", () => {
    const noise = Buffer.from("/JS /JavaScript /Launch /AA /OpenAction /ObjStm /URI ".repeat(50), "latin1");
    const pdf = Buffer.concat([Buffer.from(`%PDF-1.5\n<< /Type /Catalog /Length ${noise.length} >>\nstream\n`), noise, Buffer.from("\nendstream\n%%EOF")]);
    expect(hasActiveContent(pdf)).toBe(false);
  });
  it("still finds a dictionary that sits outside a stream", () => {
    expect(hasActiveContent(Buffer.from("%PDF-1.5\nstream\nabc\nendstream\n<< /S /JavaScript >>\n%%EOF"))).toBe(true);
  });
  it("accepts an ordinary link-free PDF", () => {
    expect(hasActiveContent(Buffer.from("%PDF-1.5\n1 0 obj\n<< /Type /Page /Contents 2 0 R >>\nendobj\n%%EOF"))).toBe(false);
  });
});

describe("compile diagnostics", () => {
  it("keeps only a short message and line number", () => {
    expect(diagnose("x\n./in/notes.tex:7: Missing } inserted.\n")).toBe("line 7: Missing inserted.");
    expect(diagnose("no recognizable error here")).toBe("the document could not be compiled");
    expect(diagnose("a.tex:3: " + "y".repeat(300))).toBe("the document could not be compiled"); // longer than a message ought to be
  });
});
