import { test } from "node:test";
import assert from "node:assert/strict";
import { attachmentDisposition, inlineDisposition } from "../../src/lib/content-disposition.mjs";

const NAMES = [
  "cv-jane-doe-007-acme-2026-07-01.pdf",
  "cv-łukasz-acme-2026-07-01.pdf",
  "cv-陈伟-acme-2026-07-01.pdf",
  "acme-инженер-cover.pdf",
  'odd "quoted" name\\x.pdf',
  "it's (draft)*.pdf",
];

for (const name of NAMES) {
  test(`"${name}" yields a header a Response accepts and that decodes back`, () => {
    const value = inlineDisposition(name);
    const res = new Response("x", { headers: { "Content-Disposition": value } });
    const star = res.headers.get("content-disposition").match(/filename\*=UTF-8''(.+)$/)[1];
    assert.equal(decodeURIComponent(star), name);
  });
}

test("an ASCII name keeps its plain filename", () => {
  assert.equal(
    inlineDisposition("cv-a-001-acme.pdf"),
    `inline; filename="cv-a-001-acme.pdf"; filename*=UTF-8''cv-a-001-acme.pdf`,
  );
});

test("a non-ASCII name gets a quoted ASCII fallback", () => {
  assert.match(inlineDisposition("cv-łukasz.pdf"), /^inline; filename="cv-\?ukasz\.pdf"; /);
});

test("attachmentDisposition downloads a Word file", () => {
  const value = attachmentDisposition("cv-jane.docx");
  assert.match(value, /^attachment; filename="cv-jane\.docx"; /);
  const res = new Response("x", { headers: { "Content-Disposition": value } });
  assert.match(res.headers.get("content-disposition"), /^attachment;/);
});
