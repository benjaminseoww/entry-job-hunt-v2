/**
 * Containment helpers for the Word CV Garamond preview. Kept as .mjs so
 * node --test can cover ../, absolute, symlink and non-.md cases without
 * going through the Next route.
 */
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

/**
 * A readable markdown companion inside output/. Rejects non-.md files,
 * missing paths, directories, and anything whose real path escapes outputDir
 * (including a symlink planted in output/ that points outside).
 * @param {string | null | undefined} candidate
 * @param {string} outputDir
 * @returns {string | null} real path, or null
 */
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
