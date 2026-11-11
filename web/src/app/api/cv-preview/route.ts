import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, isRegularContainedFile, pdfPathStatusForReport } from "@/lib/career-ops";
import { resolvePdfIndexPath } from "@/lib/core/pdf-index";
import { pdfIndexCompanionForReport } from "@/lib/apply/cv-selection.mjs";
import { isDocxPath } from "@/lib/cv-format.mjs";
import { garamondPreviewHtml } from "@/lib/garamond-preview.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function containedOutputFile(abs: string, outputDir: string): string | null {
  const resolved = path.resolve(abs);
  if (!isRegularContainedFile(resolved, outputDir)) return null;
  return resolved;
}

function siblingMarkdown(docxPath: string): string {
  return docxPath.replace(/\.docx$/i, ".md");
}

export async function GET(req: NextRequest) {
  const n = (req.nextUrl.searchParams.get("n") ?? "").trim();
  const company = (req.nextUrl.searchParams.get("company") ?? "").trim();
  if (!n) return new Response("report number required", { status: 400 });
  if (!/^\d+$/.test(n)) return new Response("invalid report number", { status: 400 });

  const exact = await pdfPathStatusForReport(n);
  if (exact.status !== "found" || !isDocxPath(exact.path)) {
    return new Response("Word CV preview is unavailable", { status: 404 });
  }

  const root = careerOpsRoot();
  const outputDir = path.resolve(root, "output");
  let mdPath: string | null = null;
  const indexPath = await resolvePdfIndexPath();
  if (indexPath) {
    try {
      const tsv = fs.readFileSync(indexPath, "utf8");
      const companion = pdfIndexCompanionForReport(tsv, Number.parseInt(n, 10));
      if (companion.found && companion.html) {
        mdPath = containedOutputFile(path.resolve(root, companion.html), outputDir);
      }
    } catch {
      /* fall through to sibling */
    }
  }
  if (!mdPath) mdPath = containedOutputFile(siblingMarkdown(exact.path), outputDir);
  if (!mdPath) return new Response("Preview of the Word file is unavailable", { status: 404 });

  let markdown: string;
  try {
    markdown = fs.readFileSync(/* turbopackIgnore: true */ mdPath, "utf8");
  } catch {
    return new Response("could not read the preview", { status: 500 });
  }

  const qs = new URLSearchParams({ n });
  if (company) qs.set("company", company);
  const html = garamondPreviewHtml({
    markdown,
    downloadHref: `/api/cv-pdf?${qs}`,
    filename: path.basename(exact.path),
  });
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
