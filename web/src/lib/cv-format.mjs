/** User-facing Word vs PDF. Internal keys stay `pdf`. */

export function isDocxPath(pathOrName) {
  return /\.docx$/i.test(String(pathOrName ?? ""));
}

export function isCvOutputFilename(name) {
  const lower = String(name ?? "").toLowerCase();
  return lower.endsWith(".pdf") || lower.endsWith(".docx");
}

/** Anything that is not `.docx` is PDF, including a missing path, so apply copy still has a word. */
export function cvFormatLabel(pathOrName) {
  return isDocxPath(pathOrName) ? "Word" : "PDF";
}

export function tailoredCvAttachCopy(pathOrName) {
  return `Your tailored CV (${cvFormatLabel(pathOrName)}) will be attached automatically — you can swap it on the real form.`;
}

/** `cvIsWord` is the server prop until reload; the just-finished job kind covers a first Word run. */
export function isWordCvView(cvIsWord, jobKind) {
  return cvIsWord === true || jobKind === "docx";
}
