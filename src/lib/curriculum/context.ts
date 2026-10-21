import { canonicalJson, sha256Hex } from "@/lib/domain/hash";
import type { Capability } from "./capabilities";
import type { Coverage, DatasetKind } from "./dataset-schema";

/**
 * The resolved curriculum context for one lesson: an immutable snapshot taken at enqueue time, so later
 * dataset updates never change a lesson that was already generated. Everything that appears in a
 * document as a curriculum alignment statement must be derived from this object (never from model text).
 */
export interface CurriculumContext {
  curriculum: {
    id: string;
    name: string;
    educationSystem: { id: string; name: string; regionCode: string };
    version: {
      id: string;
      label: string;
      kind: DatasetKind;
      source: { title: string; url: string | null; publisher: string | null; retrievedAt: string | null };
    };
  };
  level: { id: string; label: string } | null;
  course: { id: string; code: string; title: string };
  unit: { id: string; code: string | null; title: string };
  topic: { id: string; title: string };
  objectives: {
    id: string;
    officialCode: string;
    label: string;
    coverage: Coverage;
    note: string | null;
    source: { ref: string; page: string | null };
  }[];
  prerequisites: { topicId: string; title: string }[];
  concepts: { id: string; name: string; coverage: Coverage; note: string | null; capability: Pick<Capability, "generatorVersion" | "validatorVersion" | "forms" | "difficulties" | "outcomes"> }[];
  /** False for sample, synthetic and suggested data: such lessons must not render any curriculum alignment claim. */
  alignmentClaimsAllowed: boolean;
  contextHash: string;
}

/** Only a real, reviewed dataset may ever allow a curriculum alignment claim; sample, synthetic and suggested data never do. */
export function alignmentClaimsAllowedFor(kind: DatasetKind): boolean {
  return kind === "real";
}

export type UnhashedContext = Omit<CurriculumContext, "contextHash">;

export function contextHashOf(context: UnhashedContext): string {
  return `sha256:${sha256Hex(canonicalJson(context))}`;
}

export function withContextHash(context: UnhashedContext): CurriculumContext {
  return { ...context, contextHash: contextHashOf(context) };
}

export function verifyContextHash(context: CurriculumContext): boolean {
  const { contextHash, ...rest } = context;
  return contextHash === contextHashOf(rest);
}
