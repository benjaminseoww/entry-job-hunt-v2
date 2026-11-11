import { NextRequest } from "next/server";
import { resolveTailoredCv } from "@/lib/apply/cv";
import { cvFormatLabel } from "@/lib/cv-format.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Word or PDF for the file apply will actually attach. */
export async function GET(req: NextRequest) {
  const application = (req.nextUrl.searchParams.get("application") ?? "").trim();
  const company = (req.nextUrl.searchParams.get("company") ?? "").trim();
  const path = await resolveTailoredCv(company || undefined, application || undefined);
  return Response.json({ format: cvFormatLabel(path) }, { headers: { "Cache-Control": "no-store" } });
}
