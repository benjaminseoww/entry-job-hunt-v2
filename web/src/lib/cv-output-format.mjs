/** Generate starts the docx worker only when `cv.output_format` is `docx`; every other value stays pdf. */
import fs from "node:fs";
import * as yaml from "js-yaml";
import { getProfilePath } from "./core/profile-path.mjs";

export function readCvOutputFormat(root, env = process.env) {
  try {
    const parsed = yaml.load(fs.readFileSync(getProfilePath(root, { env }), "utf8"));
    const value = String(parsed?.cv?.output_format ?? "").trim().toLowerCase();
    return value === "docx" ? "docx" : "pdf";
  } catch {
    return "pdf";
  }
}

export function cvJobKind(outputFormat) {
  return outputFormat === "docx" ? "docx" : "pdf";
}
