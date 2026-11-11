/**
 * lib/docx-text.mjs — plain text of a Word document, for the fact gate and
 * the generator's round-trip check.
 *
 * Reads word/document.xml through lib/docx-zip.mjs and returns paragraph
 * texts in document order. No filesystem access; the caller hands in a
 * buffer. Imports nothing from the renderer, so verify-cv-facts.mjs can
 * load this without pulling in the Garamond template.
 */

import { readZip } from './docx-zip.mjs';

function unescapeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/**
 * Paragraph texts of a .docx, in document order. Tabs become `\t`.
 *
 * @param {Buffer} buffer
 * @returns {string[]}
 */
export function extractDocxParagraphs(buffer) {
  const parts = readZip(buffer);
  const doc = parts.get('word/document.xml');
  if (!doc) throw new Error('Not a Word document: word/document.xml is missing');
  const xml = doc.toString('utf8');
  const out = [];
  for (const m of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    let text = '';
    for (const t of m[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>/g)) {
      text += t[0] === '<w:tab/>' ? '\t' : unescapeXml(t[1]);
    }
    out.push(text);
  }
  return out;
}

/**
 * Visible text of a .docx, paragraphs joined with newlines. Empty
 * paragraphs stay as blank lines so a later reader can see the breaks.
 *
 * @param {Buffer} buffer
 * @returns {string}
 */
export function extractDocxText(buffer) {
  return extractDocxParagraphs(buffer).join('\n');
}
