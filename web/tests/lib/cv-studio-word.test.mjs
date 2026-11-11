// CV Studio refuses an indexed Word CV instead of falling through to an older
// company HTML file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../helpers/web-ts-alias-loader.mjs";

const { loadStudio, WORD_CV_MESSAGE } = await import("../../src/lib/cv-studio/server.ts");

test("loadStudio refuses a Word index row", async () => {
  const root = mkdtempSync(join(tmpdir(), "cv-studio-word-"));
  mkdirSync(join(root, "output"), { recursive: true });
  mkdirSync(join(root, "data"), { recursive: true });
  mkdirSync(join(root, "reports"), { recursive: true });
  writeFileSync(join(root, "output", "cv-acme.docx"), "PK-docx");
  writeFileSync(join(root, "output", "cv-acme-old.html"), "<html>old</html>");
  writeFileSync(
    join(root, "data", "pdf-index.tsv"),
    "# report\tpdf\thtml\tformat\tdate\tkind\n12\toutput/cv-acme.docx\toutput/cv-acme.md\tletter\t2026-01-10\tcv\n",
  );
  // Static stub: join the arguments pdf-index.ts actually passes. Do not
  // interpolate temp paths into generated JS — CodeQL flags that as
  // js/bad-code-sanitization even in tests.
  writeFileSync(
    join(root, "tracker-utils.mjs"),
    [
      'import { dirname, join } from "node:path";',
      "export const resolveTrackerPath = (rootDir) => join(rootDir, \"data\", \"applications.md\");",
      "export const resolvePdfIndexPath = (trackerPath) => join(dirname(trackerPath), \"pdf-index.tsv\");",
    ].join("\n"),
  );
  writeFileSync(join(root, "reports", "012-acme-2026-01-10.md"), "# Offer: Acme -- Staff\n");
  const prev = process.env.CAREER_OPS_ROOT;
  process.env.CAREER_OPS_ROOT = root;
  try {
    const load = await loadStudio("12");
    assert.deepEqual(load, { ok: false, reason: "word-cv" });
    assert.equal(WORD_CV_MESSAGE, "CV Studio does not edit Word CVs yet");
  } finally {
    if (prev === undefined) delete process.env.CAREER_OPS_ROOT;
    else process.env.CAREER_OPS_ROOT = prev;
    rmSync(root, { recursive: true, force: true });
  }
});
