import fs from "node:fs";
import path from "node:path";

export const PREVIEW_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
};

export function siblingMarkdown(docxPath) {
  return String(docxPath ?? "").replace(/\.docx$/i, ".md");
}

/** Reject anything whose real path is not a `.md` file inside output/, including a symlink planted there. */
export function containedPreviewMarkdown(candidate, outputDir) {
  if (!candidate) return null;
  let resolved;
  try {
    resolved = fs.realpathSync(path.resolve(candidate));
  } catch {
    return null;
  }
  if (!resolved.toLowerCase().endsWith(".md")) return null;
  let outputRoot;
  try {
    outputRoot = fs.realpathSync(outputDir);
  } catch {
    return null;
  }
  const prefix = outputRoot.endsWith(path.sep) ? outputRoot : outputRoot + path.sep;
  if (resolved !== outputRoot && !resolved.startsWith(prefix)) return null;
  try {
    if (!fs.statSync(resolved).isFile()) return null;
  } catch {
    return null;
  }
  return resolved;
}
