import type { Dataset } from "./dataset-schema";

// Own-wording check for researched datasets (D-75: no copied syllabus text). The source documents are not in the
// repository, so the check takes their extracted text as input. It measures the longest run of consecutive words that a
// topic's title and summary, read together, share with any one source.

/** A run longer than this many words is copied wording. Measured on title and summary together, not field by field. */
export const MAX_SHARED_RUN = 5;

/** Runs are found by extending matches of this many words, so a shared run shorter than this is reported as 0. */
const SEED = 3;
const SEPARATOR = "|"; // cannot occur in a token, so a run never crosses from one source into the next

export interface SourceIndex {
  tokens: string[];
  seeds: Map<string, number[]>;
}

/** Lower-cased words; punctuation and hyphens split words, so "Unit-pricing," and "unit pricing" compare equal. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t !== "");
}

export function buildSourceIndex(texts: string[]): SourceIndex {
  const tokens: string[] = [];
  for (const text of texts) {
    for (const token of tokenize(text)) tokens.push(token); // not push(...spread): a long source would overflow the call stack
    tokens.push(SEPARATOR);
  }
  const seeds = new Map<string, number[]>();
  for (let i = 0; i + SEED <= tokens.length; i++) {
    const seed = tokens.slice(i, i + SEED);
    if (seed.includes(SEPARATOR)) continue;
    const key = seed.join(" ");
    const at = seeds.get(key);
    if (at) at.push(i);
    else seeds.set(key, [i]);
  }
  return { tokens, seeds };
}

/** Length in words of the longest run of `text` found, in order and unbroken, in one of the indexed sources. */
export function longestSharedRun(text: string, index: SourceIndex): number {
  const words = tokenize(text);
  let best = 0;
  for (let i = 0; i + SEED <= words.length; i++) {
    const at = index.seeds.get(words.slice(i, i + SEED).join(" "));
    if (!at) continue;
    for (const start of at) {
      let length = SEED;
      while (i + length < words.length && start + length < index.tokens.length && words[i + length] === index.tokens[start + length]) length++;
      if (length > best) best = length;
    }
  }
  return best;
}

export interface CopiedWording {
  id: string;
  title: string;
  /** Length in words of the longest shared run. */
  run: number;
}

/** Topics whose title and summary together share more than MAX_SHARED_RUN consecutive words with the sources. */
export function findCopiedWording(dataset: Dataset, index: SourceIndex): CopiedWording[] {
  const hits: CopiedWording[] = [];
  for (const t of dataset.structure.topics) {
    const run = longestSharedRun(`${t.title} ${t.summary}`, index);
    if (run > MAX_SHARED_RUN) hits.push({ id: t.id, title: t.title, run });
  }
  return hits;
}
