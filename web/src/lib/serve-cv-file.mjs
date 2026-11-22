import fs from "node:fs";
import path from "node:path";
import { attachmentDisposition, cvPdfDisposition, DOCX_MIME } from "./content-disposition.mjs";

/**
 * Serve an indexed CV as a Response. A `.docx` downloads as Word; a PDF stays
 * inline unless `downloadFlag === "1"`. Lives outside the Next route so
 * `node --test` can exercise it without the `next` package (web CI installs web
 * deps; a root-level run does not).
 *
 * @param {string} file
 * @param {string | null} [downloadFlag]
 * @returns {Response}
 */
export function servePdf(file, downloadFlag = null) {
  const buf = fs.readFileSync(file);
  const name = path.basename(file);
  const isDocx = name.toLowerCase().endsWith(".docx");
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": isDocx ? DOCX_MIME : "application/pdf",
      "Content-Disposition": isDocx ? attachmentDisposition(name) : cvPdfDisposition(file, downloadFlag),
      "Cache-Control": "no-store",
    },
  });
}
