/**
 * A minimal ustar writer and a STRICT ustar reader, with no dependency. The worker sends the container a tar of the
 * documents to compile and reads back a tar of the results; the output comes from a process that ran untrusted
 * input, so it is parsed as hostile data: only plain files with short flat names, bounded sizes and counts.
 */
export class TarError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "TarError";
  }
}

export interface TarEntry {
  name: string;
  data: Uint8Array;
}

export interface TarLimits {
  maxEntries: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

const BLOCK = 512;
const FLAT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const octal = (value: number, width: number) => value.toString(8).padStart(width - 1, "0") + "\0";

/** Writes a tar of regular files. Names must be flat; the caller chooses them, never user input. */
export function writeTar(entries: readonly TarEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const encoder = new TextEncoder();
  for (const { name, data } of entries) {
    if (!FLAT_NAME.test(name)) throw new TarError("bad_name");
    const header = new Uint8Array(BLOCK);
    const put = (offset: number, text: string) => header.set(encoder.encode(text), offset);
    put(0, name);
    put(100, octal(0o444, 8)); // mode
    put(108, octal(0, 8)); // uid
    put(116, octal(0, 8)); // gid
    put(124, octal(data.byteLength, 12)); // size
    put(136, octal(0, 12)); // mtime: fixed, so the same input is the same archive
    put(148, "        "); // checksum placeholder (spaces)
    put(156, "0"); // regular file
    put(257, "ustar\0");
    put(263, "00");
    let sum = 0;
    for (const byte of header) sum += byte;
    put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
    parts.push(header, data, new Uint8Array((BLOCK - (data.byteLength % BLOCK)) % BLOCK));
  }
  parts.push(new Uint8Array(BLOCK * 2)); // end of archive
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

function field(block: Uint8Array, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  try {
    return decoder.decode(end === -1 ? slice : slice.subarray(0, end));
  } catch {
    throw new TarError("bad_header");
  }
}

function parseOctal(text: string): number {
  const trimmed = text.trim();
  if (!/^[0-7]{1,12}$/.test(trimmed)) throw new TarError("bad_number");
  return Number.parseInt(trimmed, 8);
}

/**
 * Reads a tar of plain files. Rejects anything else: links, devices, directories (except the root "./" GNU tar
 * adds), extended or long-name headers, names with a path, `..`, duplicates, bad checksums, truncation, and any
 * entry or total size above the limits. Returns the files in archive order.
 */
export function readTar(archive: Uint8Array, limits: TarLimits): TarEntry[] {
  const entries: TarEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let at = 0;
  while (true) {
    if (at + BLOCK > archive.byteLength) throw new TarError("truncated");
    const header = archive.subarray(at, at + BLOCK);
    if (header.every((b) => b === 0)) return entries; // end marker
    at += BLOCK;

    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!;
    if (sum !== parseOctal(field(header, 148, 8))) throw new TarError("bad_checksum");

    const rawName = field(header, 0, 100);
    const type = String.fromCharCode(header[156] === 0 ? 48 : header[156]!);
    const size = parseOctal(field(header, 124, 12));
    if (field(header, 345, 155) !== "") throw new TarError("long_name"); // ustar prefix: not used by anyone legitimate

    if (type === "5" && (rawName === "./" || rawName === ".")) {
      if (size !== 0) throw new TarError("bad_directory");
      continue; // the root directory entry GNU tar writes for `tar -C out .`
    }
    if (type !== "0") throw new TarError("not_a_regular_file"); // symlink, hardlink, device, fifo, pax/gnu extension, directory
    const name = rawName.startsWith("./") ? rawName.slice(2) : rawName;
    if (!FLAT_NAME.test(name) || name === "." || name === "..") throw new TarError("bad_name");
    if (seen.has(name)) throw new TarError("duplicate_name");
    seen.add(name);
    if (entries.length >= limits.maxEntries) throw new TarError("too_many_entries");
    if (size > limits.maxFileBytes) throw new TarError("file_too_large");
    total += size;
    if (total > limits.maxTotalBytes) throw new TarError("output_too_large");
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (at + padded > archive.byteLength) throw new TarError("truncated");
    entries.push({ name, data: archive.slice(at, at + size) });
    at += padded;
  }
}
