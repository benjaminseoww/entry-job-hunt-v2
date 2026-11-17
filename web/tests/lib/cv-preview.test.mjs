import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { containedPreviewMarkdown, PREVIEW_HEADERS, siblingMarkdown } from "../../src/lib/cv-preview.mjs";

test("PREVIEW_HEADERS: nosniff plus a tight style-only CSP", () => {
  assert.equal(PREVIEW_HEADERS["X-Content-Type-Options"], "nosniff");
  assert.equal(PREVIEW_HEADERS["Content-Security-Policy"], "default-src 'none'; style-src 'unsafe-inline'");
  assert.match(PREVIEW_HEADERS["Content-Type"], /text\/html/);
});

test("siblingMarkdown swaps a .docx for .md", () => {
  assert.equal(siblingMarkdown("output/cv-acme.docx"), "output/cv-acme.md");
  assert.equal(siblingMarkdown("output/cv-acme.DOCX"), "output/cv-acme.md");
});

test("containedPreviewMarkdown: ../, absolute, symlink and non-.md are rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "co-cv-preview-"));
  try {
    const output = join(root, "output");
    mkdirSync(output, { recursive: true });
    const inside = join(output, "cv.md");
    writeFileSync(inside, "# Jane\n");
    writeFileSync(join(output, "notes.txt"), "not markdown");
    const outside = join(root, "secret.md");
    writeFileSync(outside, "# leak\n");
    symlinkSync(outside, join(output, "link.md"));

    assert.equal(containedPreviewMarkdown(inside, output), realpathSync(inside));
    assert.equal(containedPreviewMarkdown(join(output, "notes.txt"), output), null);
    assert.equal(containedPreviewMarkdown(join(output, "..", "secret.md"), output), null);
    assert.equal(containedPreviewMarkdown(outside, output), null);
    assert.equal(containedPreviewMarkdown(join(output, "link.md"), output), null);
    assert.equal(containedPreviewMarkdown("/etc/passwd", output), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
