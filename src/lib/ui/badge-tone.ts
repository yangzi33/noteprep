export type BadgeTone = "accent" | "neutral" | "danger";

/** Tone of a job or export state badge: success is accent, failure is danger, everything else (including canceled) is neutral. */
export function badgeTone(state: string): BadgeTone {
  if (state === "succeeded") return "accent";
  if (state === "failed") return "danger";
  return "neutral";
}
