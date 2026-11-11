/**
 * Word vs PDF from a file path or name. Internal keys stay `pdf`; this is the
 * user-facing format label (D5) and the apply-copy helper (PR 5.4).
 */

/** @param {string | null | undefined} pathOrName */
export function isDocxPath(pathOrName) {
  return /\.docx$/i.test(String(pathOrName ?? ""));
}

/** A tailored CV file in output/: PDF or Word. */
export function isCvOutputFilename(name) {
  const lower = String(name ?? "").toLowerCase();
  return lower.endsWith(".pdf") || lower.endsWith(".docx");
}

/**
 * User-facing format for a CV file. Anything that is not `.docx` is PDF —
 * including a missing path, so apply copy still has a concrete word.
 * @param {string | null | undefined} pathOrName
 * @returns {"Word" | "PDF"}
 */
export function cvFormatLabel(pathOrName) {
  return isDocxPath(pathOrName) ? "Word" : "PDF";
}

/** Apply-form copy: Word or PDF from the file that will actually be attached. */
export function tailoredCvAttachCopy(pathOrName) {
  return `Your tailored CV (${cvFormatLabel(pathOrName)}) will be attached automatically — you can swap it on the real form.`;
}
