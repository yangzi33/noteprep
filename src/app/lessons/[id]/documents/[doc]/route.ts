import { z } from "zod";
import { domainErrorCode } from "@/lib/domain/errors";
import { DOCUMENT_KINDS } from "@/lib/package/schema";
import { getRequestUser } from "@/lib/server/auth/require-user";
import { webDal } from "@/lib/server/dal/instance";
import { createServerSupabase } from "@/lib/supabase/server";
import { ARTIFACT_BUCKET } from "@/lib/storage/supabase-store";

/** A signed URL lives just long enough for the browser to follow the redirect; every view asks for a fresh one. */
const SIGNED_URL_SECONDS = 60;

const HEADERS = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
const Params = z.object({ id: z.uuid(), doc: z.enum(DOCUMENT_KINDS) });
const Query = z.object({ rev: z.uuid(), download: z.enum(["1"]).optional() });

const notFound = () => new Response(null, { status: 404, headers: HEADERS });

/**
 * Preview and download of one finished PDF. Identity comes from the verified session; the lesson, revision and file are
 * looked up for THAT owner and the path comes from the revision's own manifest, never from the request. The browser is
 * then sent to a short-lived URL signed with the user's own session, so Storage's own rules apply a second time.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string; doc: string }> }) {
  const user = await getRequestUser();
  if (!user) return Response.json({ error: "unauthenticated" }, { status: 401, headers: HEADERS });

  const p = Params.safeParse(await params);
  const q = Query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!p.success || !q.success) return notFound();

  let artifact;
  try {
    artifact = await webDal().lessons.getArtifact(user.ctx, p.data.id, q.data.rev, p.data.doc);
  } catch (error) {
    if (domainErrorCode(error) === "NOT_FOUND") return notFound();
    throw error;
  }

  const supabase = await createServerSupabase();
  const { data, error } = await supabase.storage
    .from(ARTIFACT_BUCKET)
    .createSignedUrl(artifact.path, SIGNED_URL_SECONDS, q.data.download ? { download: artifact.filename } : undefined);
  if (error || !data) return new Response("This file is not available right now. Please try again in a moment.", { status: 502, headers: { ...HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
  return new Response(null, { status: 302, headers: { ...HEADERS, Location: data.signedUrl } });
}
