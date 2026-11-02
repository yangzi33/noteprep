import { z } from "zod";
import { domainErrorCode } from "@/lib/domain/errors";
import { DOCUMENT_KINDS } from "@/lib/package/schema";
import { getRequestUser } from "@/lib/server/auth/require-user";
import { webDal } from "@/lib/server/dal/instance";
import { logActionFailure } from "@/lib/server/log-action";
import { createServerSupabase } from "@/lib/supabase/server";
import { ARTIFACT_BUCKET } from "@/lib/storage/supabase-store";

/** A signed URL lives just long enough for the browser to follow the redirect; every view asks for a fresh one. */
const SIGNED_URL_SECONDS = 60;

const HEADERS = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
const Params = z.object({ id: z.uuid(), doc: z.enum(DOCUMENT_KINDS) });
const Query = z.object({ rev: z.uuid(), download: z.enum(["1"]).optional() });

/**
 * A tutor following a link (a download, or "Open in a new tab") needs a page; the preview iframe and plain fetches keep
 * plain status codes. Only Sec-Fetch-Dest: document marks a navigation: neither the query string nor an Accept header
 * does, so scripted clients and browsers that send no fetch metadata (whose iframe also asks for text/html) keep status codes.
 */
function isNavigation(request: Request): boolean {
  return request.headers.get("sec-fetch-dest") === "document";
}

const redirect = (location: string) => new Response(null, { status: 303, headers: { ...HEADERS, Location: location } });

/** Where a navigation goes when the file cannot be served: the lesson page explains it. */
const unavailable = (lessonId: string | undefined) => redirect(lessonId ? `/lessons/${lessonId}?error=file_unavailable` : "/lessons");

/**
 * Preview and download of one finished PDF. Identity comes from the verified session; the lesson, revision and file are
 * looked up for THAT owner and the path comes from the revision's own manifest, never from the request. The browser is
 * then sent to a short-lived URL signed with the user's own session, so Storage's own rules apply a second time.
 * A navigation that cannot be served is redirected to a page that says so; the iframe and other fetches get status codes.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string; doc: string }> }) {
  const p = Params.safeParse(await params);
  const q = Query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  const navigation = isNavigation(request);
  const lessonId = p.success ? p.data.id : undefined;
  const failed = (status: 404 | 502) =>
    navigation
      ? unavailable(lessonId)
      : new Response(status === 404 ? null : "This file could not be opened.", { status, headers: { ...HEADERS, "Content-Type": "text/plain; charset=utf-8" } });

  const user = await getRequestUser();
  if (!user) return navigation ? redirect("/login") : Response.json({ error: "unauthenticated" }, { status: 401, headers: HEADERS });

  // The same rule as the page: only an active account is served. A profile being deleted (or not created yet) gets the
  // same answer as a file that does not exist.
  try {
    if ((await webDal().account.getStatus(user.ctx)) !== "active") return failed(404);
  } catch (error) {
    logActionFailure("artifact_account_check_failed", error, lessonId ? { lessonId } : {});
    return failed(502);
  }

  if (!p.success || !q.success) return failed(404);

  let artifact;
  try {
    artifact = await webDal().lessons.getArtifact(user.ctx, p.data.id, q.data.rev, p.data.doc);
  } catch (error) {
    if (domainErrorCode(error) === "NOT_FOUND") return failed(404);
    logActionFailure("artifact_lookup_failed", error, { lessonId: p.data.id });
    return failed(502);
  }

  const supabase = await createServerSupabase();
  const { data, error } = await supabase.storage
    .from(ARTIFACT_BUCKET)
    .createSignedUrl(artifact.path, SIGNED_URL_SECONDS, q.data.download ? { download: artifact.filename } : undefined);
  if (error || !data) {
    // Structured line without the path, the signed URL or any lesson content.
    console.error(JSON.stringify({ ts: new Date().toISOString(), event: "artifact_sign_failed", document: p.data.doc, status: Number((error as { status?: unknown; statusCode?: unknown } | null)?.statusCode ?? (error as { status?: unknown } | null)?.status) || null }));
    return failed(502);
  }
  return new Response(null, { status: 302, headers: { ...HEADERS, Location: data.signedUrl } });
}
