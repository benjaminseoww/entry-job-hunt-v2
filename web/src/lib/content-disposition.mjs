<<<<<<< HEAD
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * `Content-Disposition` for a served file. Header values must be ByteStrings,
 * so a raw "cv-łukasz-….pdf" makes `new Response` throw. The quoted `filename`
 * is an ASCII fallback; `filename*` carries the real name (RFC 6266).
=======
import path from "node:path";

/**
 * Content-Disposition for a served file. Header values must be ByteStrings,
 * so a raw "cv-łukasz-….pdf" makes `new Response` throw. The quoted
 * `filename` is an ASCII fallback; `filename*` carries the real name
 * (RFC 6266).
>>>>>>> career-ops-v1.40.0
 *
 * @param {"inline" | "attachment"} type
 * @param {string} filename
 * @param {"inline"|"attachment"} [kind]
 * @returns {string}
 */
<<<<<<< HEAD
function contentDisposition(filename, kind = "inline") {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "?").replace(/(["\\])/g, "\\$1");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** @param {string} filename */
export function inlineDisposition(filename) {
  return contentDisposition(filename, "inline");
}

/** @param {string} filename */
export function attachmentDisposition(filename) {
  return contentDisposition(filename, "attachment");
=======
function contentDisposition(type, filename) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "?").replace(/(["\\])/g, "\\$1");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function inlineDisposition(filename) {
  return contentDisposition("inline", filename);
}

export function attachmentDisposition(filename) {
  return contentDisposition("attachment", filename);
}

export function cvPdfDisposition(file, downloadFlag) {
  const filename = path.basename(file);
  return downloadFlag === "1" ? attachmentDisposition(filename) : inlineDisposition(filename);
>>>>>>> career-ops-v1.40.0
}
