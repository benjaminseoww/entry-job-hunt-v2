import { NextRequest } from "next/server";
import fs from "node:fs";
<<<<<<< HEAD
import path from "node:path";
import { resolveTailoredCv } from "@/lib/apply/cv";
import { careerOpsRoot, isRegularContainedFile, pdfPathStatusForReport } from "@/lib/career-ops";
import { companySlug } from "@/lib/company-slug.mjs";
import { matchesTailoredCv, sortNewestFirst } from "@/lib/apply/cv-match.mjs";
import { servePdf } from "@/lib/serve-cv-file.mjs";
=======
import { cvPdfDisposition } from "@/lib/content-disposition.mjs";
import { locateTailoredPdf } from "@/lib/cv-pdf-file";
import { cvPdfSelectors } from "@/lib/cv-pdf-query.mjs";
>>>>>>> career-ops-v1.40.0

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

<<<<<<< HEAD
// Serve the tailored CV PDF the pdf mode wrote to output/ for a given offer.
// Inline so it opens in the browser. Local-first: reads the user's own output/
// dir.
//
// Three resolution paths, in order. "n" (a REPORT number, e.g. from a report's
// own "View tailored CV" link) and "application" (a TRACKER ROW number, e.g.
// from the Apply flow) are different number spaces and both resolve the EXACT
// PDF recorded in data/pdf-index.tsv — application via the row's own Report
// cell. The company slug is the fallback for reports generated before that
// manifest existed. The fallback uses the SAME matching contract as
// resolveTailoredCv (see cv-match.mjs) so this and the apply flow always land
// on the same file.
=======
function servePdf(file: string, downloadFlag: string | null): Response {
  const buf = fs.readFileSync(file);
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": cvPdfDisposition(file, downloadFlag),
      "Cache-Control": "no-store",
    },
  });
}

>>>>>>> career-ops-v1.40.0
export async function GET(req: NextRequest) {
  const located = await locateTailoredPdf(cvPdfSelectors(req.nextUrl.searchParams));
  if (!("file" in located)) return new Response(located.message, { status: located.status });
  try {
<<<<<<< HEAD
    files = fs
      .readdirSync(dir)
      .filter((f) => {
        const lower = f.toLowerCase();
        return lower.endsWith(".pdf") || lower.endsWith(".docx");
      })
      .filter((f) => matchesTailoredCv(f.toLowerCase(), slug))
      // sortNewestFirst already drops directories and files that vanish under
      // it, but not a symlink PLACED in output/ that resolves elsewhere: that
      // one stats as a regular file and would be served. The realpath check is
      // the same one the indexed path above applies.
      .filter((f) => isRegularContainedFile(path.join(dir, f), dir));
  } catch {
    return new Response("no output directory", { status: 404 });
  }
  if (!files.length) return new Response("no tailored CV found for this offer", { status: 404 });

  const sorted = sortNewestFirst(dir, files);
  if (!sorted.length) return new Response("no tailored CV found for this offer", { status: 404 });
  try {
    return servePdf(path.join(dir, sorted[0]));
=======
    return servePdf(located.file, req.nextUrl.searchParams.get("download"));
>>>>>>> career-ops-v1.40.0
  } catch {
    return new Response("could not read the PDF", { status: 500 });
  }
}
