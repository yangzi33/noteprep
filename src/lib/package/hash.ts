import { canonicalJson, sha256Hex } from "@/lib/domain/hash";
import type { Section } from "./schema";

const h = (value: unknown) => `sha256:${sha256Hex(canonicalJson(value))}`;

/** Hash of a section's own canonical content (kind, title, blocks): what the reader would see. */
export function sectionContentHash(section: Pick<Section, "kind" | "title" | "blocks">): string {
  return h({ kind: section.kind, title: section.title, blocks: section.blocks });
}

/** Hash of everything the section was made from: its parameters and the content of the sections it depends on. */
export function sectionInputsHash(args: { kind: string; params: unknown; upstreamContentHashes: readonly string[] }): string {
  return h({ kind: args.kind, params: args.params, upstream: [...args.upstreamContentHashes].sort() });
}
