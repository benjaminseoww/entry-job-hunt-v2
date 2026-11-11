/**
 * cv.output_format from config/profile.yml. "Generate" picks the docx worker
 * when this is `docx`; every other value (html/latex/text/absent) stays pdf.
 */
import fs from "node:fs";
import * as yaml from "js-yaml";
import { getProfilePath } from "./core/profile-path.mjs";

/**
 * @param {string} root Absolute data root (careerOpsRoot()).
 * @param {Record<string, string | undefined>} [env]
 * @returns {"docx" | "pdf"}
 */
export function readCvOutputFormat(root, env = process.env) {
  try {
    const parsed = yaml.load(fs.readFileSync(getProfilePath(root, { env }), "utf8"));
    const value = String(parsed?.cv?.output_format ?? "").trim().toLowerCase();
    return value === "docx" ? "docx" : "pdf";
  } catch {
    return "pdf";
  }
}

/** Worker kind the Generate button / generatePdf action should start. */
export function cvJobKind(outputFormat) {
  return outputFormat === "docx" ? "docx" : "pdf";
}
