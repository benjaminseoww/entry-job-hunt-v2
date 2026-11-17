import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDocxEnvelope, createDocxEnvelopeFilter, OPEN_MARK, CLOSE_MARK } from "../../src/lib/docx-envelope.mjs";

const MD = "# Jane Doe\n\n## Experience\n\n- Shipped the thing";

function envelope(body) {
  return `${OPEN_MARK}>>\n${body}\n${CLOSE_MARK}`;
}

test("parseDocxEnvelope: extracts markdown from a well-formed envelope", () => {
  const result = parseDocxEnvelope(`Tailoring done.\n\n${envelope(MD)}\n\nVERDICT: 5/5 — tailored`);
  assert.equal(result.ok, true);
  assert.equal(result.markdown, MD);
});

test("parseDocxEnvelope: refuses a missing envelope", () => {
  const result = parseDocxEnvelope("VERDICT: 5/5 — no envelope");
  assert.equal(result.ok, false);
  assert.match(result.error, /no <<cv-md>> envelope/);
});

test("parseDocxEnvelope: refuses two envelopes rather than guessing", () => {
  const result = parseDocxEnvelope(`${envelope(MD)}\n${envelope(MD)}`);
  assert.equal(result.ok, false);
  assert.match(result.error, /2 <<cv-md>> envelopes/);
});

test("parseDocxEnvelope: refuses an empty envelope", () => {
  const result = parseDocxEnvelope(envelope("   "));
  assert.equal(result.ok, false);
  assert.match(result.error, /empty/);
});

test("parseDocxEnvelope: refuses markdown with no heading", () => {
  const result = parseDocxEnvelope(envelope("just a paragraph"));
  assert.equal(result.ok, false);
  assert.match(result.error, /heading/);
});

test("createDocxEnvelopeFilter: hides the body and recovers it at result()", () => {
  const filter = createDocxEnvelopeFilter();
  const visible = filter.push(`Prose\n${envelope(MD)}\nVERDICT: 5/5 — done`);
  assert.match(visible, /Prose/);
  assert.doesNotMatch(visible, /Shipped the thing/);
  const result = filter.result();
  assert.equal(result.ok, true);
  assert.equal(result.markdown, MD);
});
