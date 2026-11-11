/**
 * lib/docx-text.mjs — plain text of a Word document, for the fact gate, the
 * generator's round-trip check, and the ATS scorer's body/header split.
 *
 * Inflates only the Word parts it needs (document, headers, footers, notes)
 * through lib/docx-zip.mjs, then walks tags once. No filesystem access; the
 * caller hands in a buffer. Imports nothing from the renderer, so
 * verify-cv-facts.mjs can load this without pulling in the Garamond template.
 *
 * extractDocxText / extractDocxParagraphs stay the fact-gate API: every
 * paragraph, including headers, notes, and hidden runs. extractDocxParts
 * splits those regions and flags headings, hidden runs, tables, text boxes,
 * columns, and images for verify-ats.mjs.
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

function attrVal(attrs, local) {
  const re = new RegExp(`(?:\\w+:)?${local}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = String(attrs || '').match(re);
  return m ? (m[1] ?? m[2] ?? '') : '';
}

function flagOn(attrs) {
  const v = attrVal(attrs, 'val').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

function isWhiteColor(val) {
  const v = String(val || '').trim().replace(/^#/, '').toLowerCase();
  return v === 'fff' || v === 'ffffff';
}

function isHeadingStyle(val) {
  const s = String(val || '').replace(/\s+/g, '');
  return /^heading\d*$/i.test(s) || /^title$/i.test(s);
}

function newPara() {
  return {
    text: '',
    visibleText: '',
    keepNext: false,
    hasBottomBorder: false,
    pStyle: '',
    outlineLvl: null,
    defaultHidden: false,
    defaultWhite: false,
    defaultTiny: false,
    runVanish: false,
    runWhite: false,
    runTiny: false,
    inPPr: 0,
    inR: 0,
    inRPr: 0,
  };
}

function runIsHidden(para) {
  return para.runVanish || para.runWhite || para.runTiny;
}

function finalizeHeading(para) {
  if (isHeadingStyle(para.pStyle)) return true;
  if (para.outlineLvl !== null && para.outlineLvl >= 0 && para.outlineLvl <= 8) return true;
  if (para.keepNext && para.hasBottomBorder) return true;
  return false;
}

/**
 * Walk one Word XML part for ATS metadata. Paragraph `text` includes hidden
 * runs (same as extractParagraphsFromXml); `visibleText` drops vanished,
 * white, and tiny (`w:sz` ≤ 2) runs.
 *
 * @param {string} xml
 * @returns {{
 *   paragraphs: {text:string, visibleText:string, isHeading:boolean}[],
 *   tables: number,
 *   textBoxes: number,
 *   images: number,
 *   multiColumn: boolean,
 *   hiddenSignals: string[],
 * }}
 */
export function scanWordXml(xml) {
  const prefix = wordPrefix(xml);
  const stack = [];
  const paragraphs = [];
  const hiddenSet = new Set();
  let tables = 0;
  let textBoxes = 0;
  let images = 0;
  let multiColumn = false;
  let inT = false;

  const markHidden = (signal) => { hiddenSet.add(signal); };

  TAG_RE.lastIndex = 0;
  let cursor = 0;
  for (const m of xml.matchAll(TAG_RE)) {
    const para = stack.length ? stack[stack.length - 1] : null;
    if (inT && para && m.index > cursor) {
      const chunk = unescapeXml(xml.slice(cursor, m.index));
      para.text += chunk;
      if (!runIsHidden(para)) para.visibleText += chunk;
    }
    cursor = m.index + m[0].length;
    const name = m[1];
    const attrs = m[2] || '';
    const selfClose = /\/\s*$/.test(m[0]) || /\/\s*$/.test(attrs);
    const close = m[0].startsWith('</');
    const local = localName(name);

    if (!close) {
      if (local === 'drawing' || local === 'pict') images += 1;
      if (local === 'txbxContent' || local === 'textbox' || local === 'txbx') textBoxes += 1;
    }

    if (!isWmlTag(name, prefix)) continue;

    if (local === 'tbl' && !close) {
      tables += 1;
      continue;
    }
    if (local === 'cols' && !close) {
      const n = Number(attrVal(attrs, 'num'));
      if (Number.isFinite(n) && n > 1) multiColumn = true;
      continue;
    }

    if (local === 'p' && !close && !selfClose) {
      stack.push(newPara());
      inT = false;
      continue;
    }
    if (local === 'p' && (close || selfClose)) {
      if (selfClose && !close) stack.push(newPara());
      if (stack.length) {
        const done = stack.pop();
        paragraphs.push({
          text: done.text,
          visibleText: done.visibleText,
          isHeading: finalizeHeading(done),
        });
      }
      inT = false;
      continue;
    }
    if (!para) continue;

    if (local === 'pPr') {
      if (!close && !selfClose) para.inPPr += 1;
      else if (close && para.inPPr > 0) para.inPPr -= 1;
      continue;
    }
    if (local === 'r') {
      if (!close && !selfClose) {
        para.inR += 1;
        para.runVanish = para.defaultHidden;
        para.runWhite = para.defaultWhite;
        para.runTiny = para.defaultTiny;
      } else if (close && para.inR > 0) {
        para.inR -= 1;
        para.runVanish = para.defaultHidden;
        para.runWhite = para.defaultWhite;
        para.runTiny = para.defaultTiny;
      }
      continue;
    }
    if (local === 'rPr') {
      if (!close && !selfClose) para.inRPr += 1;
      else if (close && para.inRPr > 0) para.inRPr -= 1;
      continue;
    }
    if (local === 't' && !close && !selfClose) {
      inT = true;
      continue;
    }
    if (local === 't' && close) {
      inT = false;
      continue;
    }

    if (close) continue;

    if (local === 'keepNext' && para.inPPr) para.keepNext = flagOn(attrs);
    else if (local === 'bottom' && para.inPPr) para.hasBottomBorder = true;
    else if (local === 'pStyle' && para.inPPr) para.pStyle = attrVal(attrs, 'val');
    else if (local === 'outlineLvl' && para.inPPr) {
      const n = Number(attrVal(attrs, 'val'));
      para.outlineLvl = Number.isFinite(n) ? n : null;
    } else if ((local === 'vanish' || local === 'specVanish') && para.inRPr && flagOn(attrs)) {
      markHidden(local === 'specVanish' ? 'w:specVanish' : 'w:vanish');
      if (para.inR) para.runVanish = true;
      else if (para.inPPr) para.defaultHidden = true;
    } else if (local === 'color' && para.inRPr && isWhiteColor(attrVal(attrs, 'val'))) {
      markHidden('white text');
      if (para.inR) para.runWhite = true;
      else if (para.inPPr) para.defaultWhite = true;
    } else if ((local === 'sz' || local === 'szCs') && para.inRPr) {
      const n = Number(attrVal(attrs, 'val'));
      if (Number.isFinite(n) && n <= 2) {
        markHidden('tiny font');
        if (para.inR) para.runTiny = true;
        else if (para.inPPr) para.defaultTiny = true;
      }
    } else if (local === 'tab') {
      if (para.text) {
        para.text += '\t';
        if (!runIsHidden(para)) para.visibleText += '\t';
      }
    } else if (local === 'br' || local === 'cr') {
      para.text += '\n';
      if (!runIsHidden(para)) para.visibleText += '\n';
    } else if (local === 'noBreakHyphen') {
      para.text += '-';
      if (!runIsHidden(para)) para.visibleText += '-';
    }
  }
  while (stack.length) {
    const done = stack.pop();
    paragraphs.push({
      text: done.text,
      visibleText: done.visibleText,
      isHeading: finalizeHeading(done),
    });
  }
  return {
    paragraphs,
    tables,
    textBoxes,
    images,
    multiColumn,
    hiddenSignals: [...hiddenSet],
  };
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

function isNotesPart(name, related) {
  return NOTES_RE.test(name)
    || related.footnotes.includes(name)
    || related.endnotes.includes(name);
}

/**
 * Inflate the Word XML parts the fact gate and ATS scorer share. Throws
 * wrapped the same way extractDocxParagraphs always has.
 *
 * @param {Buffer} buffer
 * @returns {{bodyXml: string, headerFooter: string[], notes: string[]}}
 */
function readDocxXmlParts(buffer) {
  const dir = zipDirectoryMap(buffer);
  const listed = [...dir.keys()];
  const headerFooterNames = listed.filter((name) => HEADER_FOOTER_RE.test(name));
  if (headerFooterNames.length > MAX_HEADER_FOOTER_PARTS) {
    throw new Error(`too many header/footer parts (${headerFooterNames.length}; max ${MAX_HEADER_FOOTER_PARTS})`);
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

  const rels = take('word/_rels/document.xml.rels');
  const related = relatedParts(rels ? rels.toString('utf8') : '');
  const allHf = [...new Set([...headerFooterNames, ...related.header, ...related.footer])];
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

  const headerFooter = [];
  const notes = [];
  for (const name of extraNames) {
    const xml = take(name);
    if (!xml) continue;
    const str = xml.toString('utf8');
    if (isNotesPart(name, related)) notes.push(str);
    else headerFooter.push(str);
  }
  return { bodyXml: doc.toString('utf8'), headerFooter, notes };
}

function mergeScans(scans) {
  const hidden = new Set();
  let tables = 0;
  let textBoxes = 0;
  let images = 0;
  let multiColumn = false;
  const paragraphs = [];
  for (const scan of scans) {
    tables += scan.tables;
    textBoxes += scan.textBoxes;
    images += scan.images;
    if (scan.multiColumn) multiColumn = true;
    for (const signal of scan.hiddenSignals) hidden.add(signal);
    paragraphs.push(...scan.paragraphs);
  }
  return {
    paragraphs,
    tables,
    textBoxes,
    images,
    multiColumn,
    hiddenSignals: [...hidden],
  };
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
    const loaded = readDocxXmlParts(buffer);
    const out = extractParagraphsFromXml(loaded.bodyXml);
    for (const xml of loaded.headerFooter) appendParagraphs(out, xml);
    for (const xml of loaded.notes) appendParagraphs(out, xml);
    return out;
  } catch (err) {
    throw wrapDocx(err);
  }
}

/**
 * Split a .docx into body / header-footer / notes text, plus the XML
 * signals the ATS scorer needs. extractDocxText is unchanged: it still
 * concatenates every paragraph, hidden runs included, for the fact gate.
 *
 * @param {Buffer} buffer
 * @returns {{
 *   body: string,
 *   headerFooter: string,
 *   notes: string,
 *   bodyVisible: string,
 *   headings: string[],
 *   tables: number,
 *   textBoxes: number,
 *   images: number,
 *   multiColumn: boolean,
 *   hiddenSignals: string[],
 * }}
 */
export function extractDocxParts(buffer) {
  try {
    const loaded = readDocxXmlParts(buffer);
    const bodyParas = extractParagraphsFromXml(loaded.bodyXml);
    const hfParas = [];
    for (const xml of loaded.headerFooter) appendParagraphs(hfParas, xml);
    const notesParas = [];
    for (const xml of loaded.notes) appendParagraphs(notesParas, xml);
    const bodyScan = scanWordXml(loaded.bodyXml);
    const extraScan = mergeScans([
      bodyScan,
      ...loaded.headerFooter.map(scanWordXml),
      ...loaded.notes.map(scanWordXml),
    ]);
    return {
      body: bodyParas.join('\n'),
      headerFooter: hfParas.join('\n'),
      notes: notesParas.join('\n'),
      bodyVisible: bodyScan.paragraphs.map((p) => p.visibleText).join('\n'),
      headings: bodyScan.paragraphs
        .filter((p) => p.isHeading && p.visibleText.trim())
        .map((p) => p.visibleText.trim()),
      tables: extraScan.tables,
      textBoxes: extraScan.textBoxes,
      images: extraScan.images,
      multiColumn: extraScan.multiColumn,
      hiddenSignals: extraScan.hiddenSignals,
    };
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
