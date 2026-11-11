import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isDocxPath,
  isCvOutputFilename,
  cvFormatLabel,
  tailoredCvAttachCopy,
} from "../../src/lib/cv-format.mjs";
import { readReport } from "../../src/lib/report-header.mjs";
import { SAVE_ERRORS, studioErrorMessage, WORD_CV_SAVE_ERROR } from "../../src/lib/studio-errors.mjs";
import { garamondPreviewHtml, mdToGaramondHtml } from "../../src/lib/garamond-preview.mjs";
import { readCvOutputFormat, cvJobKind } from "../../src/lib/cv-output-format.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("cvFormatLabel: Word from .docx, PDF otherwise", () => {
  assert.equal(cvFormatLabel("output/cv-acme.docx"), "Word");
  assert.equal(cvFormatLabel("output/cv-acme.pdf"), "PDF");
  assert.equal(cvFormatLabel(null), "PDF");
  assert.equal(isDocxPath("cv.docx"), true);
  assert.equal(isCvOutputFilename("cv-acme.docx"), true);
  assert.equal(isCvOutputFilename("cover-acme.pdf"), true);
  assert.equal(isCvOutputFilename("notes.md"), false);
});

test("tailoredCvAttachCopy names Word or PDF from the extension", () => {
  assert.match(tailoredCvAttachCopy("cv.docx"), /Your tailored CV \(Word\) will be attached/);
  assert.match(tailoredCvAttachCopy("cv.pdf"), /Your tailored CV \(PDF\) will be attached/);
});

test("report header shows the PDF key as CV", () => {
  const parsed = readReport("# Acme — Role\n**PDF:** output/cv-acme.docx\n**Score:** 4.2/5\n");
  assert.equal(parsed.fields.find((f) => f.label === "CV")?.value, "output/cv-acme.docx");
  assert.equal(parsed.fields.some((f) => f.label === "PDF"), false);
});

test("studioErrorMessage prefers the friendly word-cv message", () => {
  assert.equal(SAVE_ERRORS["word-cv"], WORD_CV_SAVE_ERROR);
  assert.equal(studioErrorMessage({ error: "word-cv", message: WORD_CV_SAVE_ERROR }, "fallback"), WORD_CV_SAVE_ERROR);
  assert.equal(studioErrorMessage({ error: "nope", message: "friendly" }, "fallback"), "friendly");
  assert.equal(studioErrorMessage({ error: "nope" }, "fallback"), "nope");
});

test("Garamond preview is labelled Preview of the Word file", () => {
  const html = garamondPreviewHtml({
    markdown: "# Jane Doe\n\n- Shipped X",
    downloadHref: "/api/cv-pdf?n=12",
    filename: "cv-acme.docx",
  });
  assert.match(html, /Preview of the Word file/);
  assert.match(html, /Garamond/);
  assert.match(html, /Jane Doe/);
  assert.match(mdToGaramondHtml("# Jane Doe"), /<h1>Jane Doe<\/h1>/);
});

test("readCvOutputFormat: docx only when the profile says so", () => {
  const root = mkdtempSync(join(tmpdir(), "cv-out-fmt-"));
  try {
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "config", "profile.yml"), "cv:\n  output_format: docx\n");
    assert.equal(readCvOutputFormat(root, {}), "docx");
    assert.equal(cvJobKind("docx"), "docx");
    writeFileSync(join(root, "config", "profile.yml"), "cv:\n  output_format: latex\n");
    assert.equal(readCvOutputFormat(root, {}), "pdf");
    assert.equal(cvJobKind("pdf"), "pdf");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
