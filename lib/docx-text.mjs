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
 * columns, and images for verify-ats.mjs. Layout / image / hidden signals
 * come from the document body only; header, footer, and notes parts are
 * not mixed into those counts.
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

function expandHex(val) {
  const v = String(val || '').trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(v)) return v.split('').map((c) => c + c).join('');
  if (/^[0-9a-f]{6}$/.test(v)) return v;
  return '';
}

/** Exact white, or every RGB channel >= 0xF0 (near-white stuffing). */
function isNearWhiteColor(val) {
  if (isWhiteColor(val)) return true;
  const hex = expandHex(val);
  if (!hex) return false;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return r >= 0xf0 && g >= 0xf0 && b >= 0xf0;
}

const WHITE_THEME_COLORS = new Set(['lt1', 'light1', 'bg1', 'background1']);

function colorHiddenSignal(attrs) {
  const theme = attrVal(attrs, 'themeColor').trim().toLowerCase();
  if (WHITE_THEME_COLORS.has(theme)) return 'themeColor';
  const val = attrVal(attrs, 'val');
  if (isWhiteColor(val)) return 'white text';
  if (isNearWhiteColor(val)) return 'near-white text';
  return '';
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
 * webHidden, white / near-white / theme-white, white-highlight, and tiny
 * (`w:sz` ≤ 2) runs, including those inherited from `word/styles.xml`.
 *
 * @param {string} xml
 * @param {{styleHidden?: Record<string, {vanish?: boolean, white?: boolean, tiny?: boolean, signals?: string[]}>}} [opts]
 * @returns {{
 *   paragraphs: {text:string, visibleText:string, isHeading:boolean}[],
 *   tables: number,
 *   textBoxes: number,
 *   images: number,
 *   multiColumn: boolean,
 *   hiddenSignals: string[],
 * }}
 */
export function scanWordXml(xml, opts = {}) {
  const styleHidden = opts.styleHidden || {};
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

  const applyStyleFlags = (para, flags, asParagraphDefault = false) => {
    if (!flags) return;
    const toDefault = asParagraphDefault || (para.inPPr && !para.inR);
    for (const signal of flags.signals || []) markHidden(signal);
    if (flags.vanish) {
      if (toDefault) para.defaultHidden = true;
      if (para.inR) para.runVanish = true;
    }
    if (flags.white) {
      if (toDefault) para.defaultWhite = true;
      if (para.inR) para.runWhite = true;
    }
    if (flags.tiny) {
      if (toDefault) para.defaultTiny = true;
      if (para.inR) para.runTiny = true;
    }
  };

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
    else if (local === 'pStyle' && para.inPPr) {
      para.pStyle = attrVal(attrs, 'val');
      applyStyleFlags(para, styleHidden[para.pStyle], true);
    } else if (local === 'outlineLvl' && para.inPPr) {
      const n = Number(attrVal(attrs, 'val'));
      para.outlineLvl = Number.isFinite(n) ? n : null;
    } else if ((local === 'vanish' || local === 'specVanish' || local === 'webHidden') && para.inRPr && flagOn(attrs)) {
      markHidden(local === 'specVanish' ? 'w:specVanish' : local === 'webHidden' ? 'w:webHidden' : 'w:vanish');
      if (para.inR) para.runVanish = true;
      else if (para.inPPr) para.defaultHidden = true;
    } else if (local === 'color' && para.inRPr) {
      const signal = colorHiddenSignal(attrs);
      if (signal) {
        markHidden(signal);
        if (para.inR) para.runWhite = true;
        else if (para.inPPr) para.defaultWhite = true;
      }
    } else if (local === 'highlight' && para.inRPr) {
      const val = attrVal(attrs, 'val').trim().toLowerCase();
      if (val === 'white') {
        markHidden('white highlight');
        if (para.inR) para.runWhite = true;
        else if (para.inPPr) para.defaultWhite = true;
      }
    } else if (local === 'rStyle' && para.inRPr) {
      applyStyleFlags(para, styleHidden[attrVal(attrs, 'val')]);
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

function flagsFromRprInner(attrs, inner) {
  const flags = { vanish: false, white: false, tiny: false, signals: [] };
  const mark = (signal, key) => {
    flags[key] = true;
    if (!flags.signals.includes(signal)) flags.signals.push(signal);
  };
  if (/<(?:[\w.]+:)?vanish\b/i.test(inner) || /(?:\w+:)?vanish\b/i.test(attrs)) mark('w:vanish', 'vanish');
  if (/<(?:[\w.]+:)?specVanish\b/i.test(inner)) mark('w:specVanish', 'vanish');
  if (/<(?:[\w.]+:)?webHidden\b/i.test(inner)) mark('w:webHidden', 'vanish');
  for (const m of inner.matchAll(/<(?:[\w.]+:)?color\b([^>]*)\/?>/gi)) {
    const signal = colorHiddenSignal(m[1] || '');
    if (signal) mark(signal, 'white');
  }
  for (const m of inner.matchAll(/<(?:[\w.]+:)?highlight\b([^>]*)\/?>/gi)) {
    if (attrVal(m[1] || '', 'val').trim().toLowerCase() === 'white') mark('white highlight', 'white');
  }
  for (const m of inner.matchAll(/<(?:[\w.]+:)?sz(?:Cs)?\b([^>]*)\/?>/gi)) {
    const n = Number(attrVal(m[1] || '', 'val'));
    if (Number.isFinite(n) && n <= 2) mark('tiny font', 'tiny');
  }
  return flags;
}

function mergeStyleFlags(base, extra) {
  return {
    vanish: Boolean(base.vanish || extra.vanish),
    white: Boolean(base.white || extra.white),
    tiny: Boolean(base.tiny || extra.tiny),
    signals: [...new Set([...(base.signals || []), ...(extra.signals || [])])],
  };
}

/**
 * Map styleId → hidden flags from word/styles.xml. basedOn is resolved.
 * Unused styles are ignored until a paragraph or run references them.
 *
 * @param {string} xml
 * @returns {Record<string, {vanish: boolean, white: boolean, tiny: boolean, signals: string[]}>}
 */
export function parseStyleHidden(xml) {
  const raw = {};
  if (!xml) return raw;
  const styleRe = /<(?:[\w.]+:)?style\b([^>]*)>([\s\S]*?)<\/(?:[\w.]+:)?style>/gi;
  for (const m of xml.matchAll(styleRe)) {
    const id = attrVal(m[1] || '', 'styleId');
    if (!id) continue;
    const body = m[2] || '';
    const based = body.match(/<(?:[\w.]+:)?basedOn\b([^>]*)\/?>/i);
    let flags = { vanish: false, white: false, tiny: false, signals: [] };
    const rPrRe = /<(?:[\w.]+:)?rPr\b([^>]*)(?:\/>|>([\s\S]*?)<\/(?:[\w.]+:)?rPr>)/gi;
    for (const r of body.matchAll(rPrRe)) {
      flags = mergeStyleFlags(flags, flagsFromRprInner(r[1] || '', r[2] || ''));
    }
    raw[id] = { basedOn: based ? attrVal(based[1] || '', 'val') : '', ...flags };
  }
  const resolved = {};
  const walk = (id, seen) => {
    if (resolved[id]) return resolved[id];
    if (!raw[id] || seen.has(id)) {
      return { vanish: false, white: false, tiny: false, signals: [] };
    }
    seen.add(id);
    const parent = raw[id].basedOn ? walk(raw[id].basedOn, seen) : { vanish: false, white: false, tiny: false, signals: [] };
    resolved[id] = mergeStyleFlags(parent, raw[id]);
    return resolved[id];
  };
  for (const id of Object.keys(raw)) walk(id, new Set());
  return resolved;
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
 * @returns {{bodyXml: string, headerFooter: string[], notes: string[], stylesXml: string}}
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
  const stylesBuf = take('word/styles.xml');
  return {
    bodyXml: doc.toString('utf8'),
    headerFooter,
    notes,
    stylesXml: stylesBuf ? stylesBuf.toString('utf8') : '',
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
 * signals the ATS scorer needs. Tables, images, columns, text boxes, and
 * hidden runs are counted from the document body only — a footer table or
 * white-on-dark header name must not fail the body. extractDocxText is
 * unchanged: it still concatenates every paragraph, hidden runs included,
 * for the fact gate.
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
    const styleHidden = parseStyleHidden(loaded.stylesXml);
    const bodyScan = scanWordXml(loaded.bodyXml, { styleHidden });
    return {
      body: bodyParas.join('\n'),
      headerFooter: hfParas.join('\n'),
      notes: notesParas.join('\n'),
      bodyVisible: bodyScan.paragraphs.map((p) => p.visibleText).join('\n'),
      headings: bodyScan.paragraphs
        .filter((p) => p.isHeading && p.visibleText.trim())
        .map((p) => p.visibleText.trim()),
      tables: bodyScan.tables,
      textBoxes: bodyScan.textBoxes,
      images: bodyScan.images,
      multiColumn: bodyScan.multiColumn,
      hiddenSignals: bodyScan.hiddenSignals,
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
