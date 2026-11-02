import { domainErrorCode } from "@/lib/domain/errors";

/** The only fields a web-side log line may carry: opaque ids and short codes, never content, emails, tokens or messages. */
export interface ActionLogFields {
  code?: string;
  errorClass?: string;
  draftId?: string;
  versionId?: string;
  exportId?: string;
  lessonId?: string;
}

const line = (event: string, fields: ActionLogFields) => JSON.stringify({ ts: new Date().toISOString(), event, ...fields });

export function logAction(event: string, fields: ActionLogFields = {}): void {
  console.error(line(event, fields));
}

/** The error class name when it is a plain identifier, else "unknown": a thrown value can carry anything in `name`. */
function errorClassOf(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "unknown";
}

/** A domain refusal logs its code only (warn); anything else logs its error class only (error). Never the message or stack. */
export function logActionFailure(event: string, error: unknown, fields: Omit<ActionLogFields, "code" | "errorClass"> = {}): void {
  const code = domainErrorCode(error);
  if (code) console.warn(line(event, { ...fields, code }));
  else console.error(line(event, { ...fields, errorClass: errorClassOf(error) }));
}
