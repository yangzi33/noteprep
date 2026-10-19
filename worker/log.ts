/** Structured one-line logs. Never pass lesson content, prompts, tokens or URLs here. */
export function log(event: string, fields: Record<string, string | number | boolean | null | undefined> = {}): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`);
}
