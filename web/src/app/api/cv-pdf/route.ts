import { NextRequest } from "next/server";
import { locateTailoredPdf } from "@/lib/cv-pdf-file";
import { cvPdfSelectors } from "@/lib/cv-pdf-query.mjs";
import { servePdf } from "@/lib/serve-cv-file.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const located = await locateTailoredPdf(cvPdfSelectors(req.nextUrl.searchParams));
  if (!("file" in located)) return new Response(located.message, { status: located.status });
  try {
    return servePdf(located.file, req.nextUrl.searchParams.get("download"));
  } catch {
    return new Response("could not read the PDF", { status: 500 });
  }
}
