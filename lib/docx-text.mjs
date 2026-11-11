/**
 * lib/docx-text.mjs — plain text of a Word document, for the fact gate and
 * the generator's round-trip check.
 *
 * Inflates only the Word parts it needs (document, headers, footers, notes)
 * through lib/docx-zip.mjs, then walks tags once. No filesystem access; the
 * caller hands in a buffer. Imports nothing from the renderer, so
 * verify-cv-facts.mjs can load this without pulling in the Garamond template.
 */

import { MAX_ZIP_BYTES, MAX_ZIP_ENTRY_BYTES, inflateZipEntry, zipDirectoryMap } from './docx-zip.mjs';

export { MAX_ZIP_BYTES, MAX_ZIP_ENTRY_BYTES };
export const MAX_DOCX_BYTES = MAX_ZIP_BYTES;
/** Total uncompressed Word parts the fact gate will read. */
export const MAX_DOCX_TEXT_BYTES = 30 * 1024 * 1024;
/** Recruiter-visible header/footer parts; extras are refused, not skipped. */
export const MAX_HEADER_FOOTER_PARTS = 16;
/** Recruiter-visible footnote/endnote parts; extras are refused, not skipped. */
export const MAX_NOTES_PARTS = 16;

const WML_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const TAG_RE = /<\/?([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)([^>]*?)\/?>/g;
const XMLNS_RE = /xmlns(?::([A-Za-z_][\w.-]*))?\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const REL_RE = /<Relationship\b([^>]*)\/?>/gi;
const REL_ATTR_RE = /\b(Type|Target)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

function codePoint(n, original) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return original;
  try { return String.fromCodePoint(n); } catch { return original; }
}

/** Decode XML entities. Numeric references run before `&amp;`. */
export function unescapeXml(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => codePoint(parseInt(h, 16), m))
    .replace(/&#(\d+);/g, (m, d) => codePoint(Number(d), m))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function wrapDocx(err) {
  const msg = String(err?.message || err);
  if (msg.startsWith('Corrupt .docx:') || msg === 'no readable text in .docx') return err instanceof Error ? err : new Error(msg);
  return new Error(`Corrupt .docx: ${msg}`);
}

function wordPrefix(xml) {
  XMLNS_RE.lastIndex = 0;
  for (const m of xml.matchAll(XMLNS_RE)) {
    const ns = m[2] ?? m[3] ?? '';
    if (ns === WML_NS || ns.includes('wordprocessingml')) return m[1] || '';
  }
  return 'w';
}

function localName(name) {
  const i = name.indexOf(':');
  return i < 0 ? name : name.slice(i + 1);
}

function isWmlTag(name, prefix) {
  if (prefix === '') return !name.includes(':');
  return name.startsWith(`${prefix}:`);
}

/**
 * Paragraph texts of one Word XML part. Every `p` start and end is a
 * paragraph boundary (nested text-box paragraphs included). Tabs become
 * `\t`, `br`/`cr` become `\n`, `noBreakHyphen` becomes `-`.
 *
 * @param {string} xml
 * @returns {string[]}
 */
export function extractParagraphsFromXml(xml) {
  const prefix = wordPrefix(xml);
  const stack = [];
  const out = [];
  let inT = false;
  TAG_RE.lastIndex = 0;
  let cursor = 0;
  for (const m of xml.matchAll(TAG_RE)) {
    if (inT && stack.length && m.index > cursor) {
      stack[stack.length - 1] += unescapeXml(xml.slice(cursor, m.index));
    }
    cursor = m.index + m[0].length;
    const name = m[1];
    const selfClose = /\/\s*$/.test(m[0]) || /\/\s*$/.test(m[2] || '');
    const close = m[0].startsWith('</');
    if (!isWmlTag(name, prefix)) continue;
    const local = localName(name);
    if (local === 'p' && !close && !selfClose) {
      stack.push('');
      inT = false;
      continue;
    }
    if (local === 'p' && (close || selfClose)) {
      if (selfClose && !close) stack.push('');
      if (stack.length) out.push(stack.pop());
      inT = false;
      continue;
    }
    if (!stack.length) continue;
    if (local === 't' && !close && !selfClose) {
      inT = true;
      continue;
    }
    if (local === 't' && close) {
      inT = false;
      continue;
    }
    if (close) continue;
    // A tab at the start of a paragraph is Word layout (right-aligned dates),
    // not content. Once there is text, a tab is a real separator.
    if (local === 'tab') {
      if (stack[stack.length - 1]) stack[stack.length - 1] += '\t';
    } else if (local === 'br' || local === 'cr') stack[stack.length - 1] += '\n';
    else if (local === 'noBreakHyphen') stack[stack.length - 1] += '-';
  }
  while (stack.length) out.push(stack.pop());
  return out;
}

function relTypeKind(type) {
  const t = String(type || '').toLowerCase();
  if (t.endsWith('/header') || t.includes('/header')) return 'header';
  if (t.endsWith('/footer') || t.includes('/footer')) return 'footer';
  if (t.includes('footnotes')) return 'footnotes';
  if (t.includes('endnotes')) return 'endnotes';
  return null;
}

function resolveRelTarget(target) {
  const raw = String(target || '').replace(/\\/g, '/').split('?')[0].split('#')[0];
  const cleaned = raw.replace(/^\/+/, '');
  if (!cleaned || cleaned.includes('..') || cleaned.includes('\0')) {
    throw new Error('Corrupt .docx: unsafe relationship target');
  }
  if (cleaned.startsWith('word/')) return cleaned;
  const base = cleaned.split('/').pop();
  if (!base) throw new Error('Corrupt .docx: unsafe relationship target');
  return `word/${base}`;
}

function relatedParts(relsXml) {
  const found = { header: [], footer: [], footnotes: [], endnotes: [] };
  if (!relsXml) return found;
  REL_RE.lastIndex = 0;
  for (const m of relsXml.matchAll(REL_RE)) {
    const attrs = m[1] || '';
    let type = '';
    let target = '';
    REL_ATTR_RE.lastIndex = 0;
    for (const a of attrs.matchAll(REL_ATTR_RE)) {
      const val = a[2] ?? a[3] ?? '';
      if (a[1] === 'Type') type = val;
      else if (a[1] === 'Target') target = val;
    }
    const kind = relTypeKind(type);
    if (kind) found[kind].push(resolveRelTarget(target));
  }
  return found;
}

const HEADER_FOOTER_RE = /^word\/(header|footer)[^/]*\.xml$/i;
const NOTES_RE = /^word\/(footnotes|endnotes)[^/]*\.xml$/i;

function appendParagraphs(out, xml) {
  for (const paragraph of extractParagraphsFromXml(xml)) out.push(paragraph);
}

/**
 * Paragraph texts of a .docx, in document order, then headers, footers,
 * footnotes and endnotes. Headers, footers and notes come from
 * document.xml.rels and also from `word/header*.xml` / `word/footer*.xml` /
 * `word/footnotes*.xml` / `word/endnotes*.xml`, so a recruiter-visible part
 * is gated even when the rels entry is missing. Parts are inflated one at a
 * time under a total budget.
 *
 * @param {Buffer} buffer
 * @returns {string[]}
 */
export function extractDocxParagraphs(buffer) {
  try {
    const dir = zipDirectoryMap(buffer);
    const listed = [...dir.keys()];
    const headerFooter = listed.filter((name) => HEADER_FOOTER_RE.test(name));
    if (headerFooter.length > MAX_HEADER_FOOTER_PARTS) {
      throw new Error(`too many header/footer parts (${headerFooter.length}; max ${MAX_HEADER_FOOTER_PARTS})`);
    }
    const orphanNotes = listed.filter((name) => NOTES_RE.test(name));
    if (orphanNotes.length > MAX_NOTES_PARTS) {
      throw new Error(`too many notes parts (${orphanNotes.length}; max ${MAX_NOTES_PARTS})`);
    }

    let used = 0;
    const take = (name) => {
      const entry = dir.get(name);
      if (!entry) return null;
      const remaining = MAX_DOCX_TEXT_BYTES - used;
      if (remaining <= 0) throw new Error(`Word parts exceed ${MAX_DOCX_TEXT_BYTES} bytes`);
      const part = inflateZipEntry(buffer, entry, {
        maxBytes: Math.min(MAX_ZIP_ENTRY_BYTES, remaining),
      });
      used += part.length;
      if (used > MAX_DOCX_TEXT_BYTES) throw new Error(`Word parts exceed ${MAX_DOCX_TEXT_BYTES} bytes`);
      return part;
    };

    const doc = take('word/document.xml');
    if (!doc) throw new Error('Not a Word document: word/document.xml is missing');
    const out = extractParagraphsFromXml(doc.toString('utf8'));

    const rels = take('word/_rels/document.xml.rels');
    const related = relatedParts(rels ? rels.toString('utf8') : '');
    const allHf = [...new Set([...headerFooter, ...related.header, ...related.footer])];
    if (allHf.length > MAX_HEADER_FOOTER_PARTS) {
      throw new Error(`too many header/footer parts (${allHf.length}; max ${MAX_HEADER_FOOTER_PARTS})`);
    }
    const allNotes = [...new Set([...orphanNotes, ...related.footnotes, ...related.endnotes])];
    if (allNotes.length > MAX_NOTES_PARTS) {
      throw new Error(`too many notes parts (${allNotes.length}; max ${MAX_NOTES_PARTS})`);
    }
    const extraNames = [...new Set([
      ...allHf,
      ...allNotes,
    ])].filter((name) => name !== 'word/document.xml' && name !== 'word/_rels/document.xml.rels');

    for (const name of extraNames) {
      const xml = take(name);
      if (xml) appendParagraphs(out, xml.toString('utf8'));
    }
    return out;
  } catch (err) {
    throw wrapDocx(err);
  }
}

/**
 * Visible text of a .docx, paragraphs joined with newlines. Empty
 * paragraphs stay as blank lines so a later reader can see the breaks.
 * Throws when the document has no readable text.
 *
 * @param {Buffer} buffer
 * @returns {string}
 */
export function extractDocxText(buffer) {
  const paragraphs = extractDocxParagraphs(buffer);
  const text = paragraphs.join('\n');
  if (!text.replace(/\s+/g, '')) throw new Error('no readable text in .docx');
  return text;
}
