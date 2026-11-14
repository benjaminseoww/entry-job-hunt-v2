// /api/cv-pdf serves a Word index row as a download, not as inline PDF.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCX_MIME } from "../../src/lib/content-disposition.mjs";
import { servePdf } from "../../src/lib/serve-cv-file.mjs";

test("a .docx CV is served as a Word download", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cv-pdf-docx-"));
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "cv-acme.docx");
    writeFileSync(file, "PK-docx");
    const res = servePdf(file);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), DOCX_MIME);
    assert.match(res.headers.get("content-disposition"), /^attachment;/);
    assert.match(res.headers.get("content-disposition"), /cv-acme\.docx/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a .pdf CV stays inline application/pdf", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cv-pdf-pdf-"));
  try {
    const file = join(dir, "cv-acme.pdf");
    writeFileSync(file, "%PDF");
    const res = servePdf(file);
    assert.equal(res.headers.get("content-type"), "application/pdf");
    assert.match(res.headers.get("content-disposition"), /^inline;/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
