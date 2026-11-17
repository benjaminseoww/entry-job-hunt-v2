import { NextRequest } from "next/server";
import { resolveSessionCv } from "@/lib/apply/cv";
import { cvFormatLabel } from "@/lib/cv-format.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const application = (req.nextUrl.searchParams.get("application") ?? "").trim();
  const company = (req.nextUrl.searchParams.get("company") ?? "").trim();
  const title = (req.nextUrl.searchParams.get("title") ?? "").trim();
  const cvPath = await resolveSessionCv({
    company: company || undefined,
    application: application || undefined,
    title: title || undefined,
  });
  return Response.json({ format: cvFormatLabel(cvPath) }, { headers: { "Cache-Control": "no-store" } });
}
