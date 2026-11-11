/**
 * lib/docx-resume.mjs — render a tailored resume markdown file as a Word
 * (.docx) document in the Garamond layout of templates/docx/garamond/.
 *
 * Content and structure come from the markdown and nothing else: headings are
 * kept word for word and in source order. Each line is normalized with
 * lib/cv-markdown.mjs first: `[text]{.class}` spans unwrap, a trailing
 * `{#id .class}` on a heading is dropped, and `--` / `---` become an en dash
 * and an em dash. Headings are the plain words after that. The template
 * supplies only the look (font, sizes, spacing, rules, bullets, right-aligned
 * dates). Nothing is invented, reordered or dropped, with three layout-only
 * exceptions the round-trip check knows about:
 *
 *   - `# CV -- Name` becomes the centred name `Name` (the `CV --` prefix is
 *     dropped).
 *   - `**Label:** value` lines directly under the name become the contact row;
 *     the labels are dropped and the values are joined with ` | `.
 *   - An entry's title line and dates line are folded into the entry heading
 *     line: `**Title** | Company, Location (dates)`.
 *
 * Unsupported markdown (tables, code fences, images, blockquotes, numbered
 * lists) is refused, never silently flattened.
 *
 * Pure: no filesystem access except reading the template parts through the
 * `readTemplatePart` callback, so tests can run without a checkout.
 */

import { headingText, normalizePandocLine } from './cv-markdown.mjs';
import { writeZip, readZip } from './docx-zip.mjs';

/** Every number the template and the renderer must agree on (twips unless noted). */
export const LAYOUT = Object.freeze({
  font: 'Garamond',
  pageWidth: 12240,
  pageHeight: 15840,
  marginTop: 630,
  marginBottom: 414,
  marginLeft: 720,
  marginRight: 720,
  footerDistance: 342,
  textWidth: 12240 - 720 - 720,
  bodySize: 24, // half-points: 12 pt
  skillsSize: 22, // 11 pt
  nameSize: 36, // 18 pt
  lineSpacing: 252, // 1.05
  ruleSize: 6, // eighths of a point: 0.75 pt
  bodyIndent: 360,
  bulletLeft: 360,
  bulletHanging: 360,
  bulletGlyph: '▪',
  skillsAfter: 3,
  sectionBefore: 240,
  entryBefore: 126,
});

const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Template parts: package path, content type, and the relationship type from document.xml. */
export const TEMPLATE_PARTS = Object.freeze([
  { path: 'word/styles.xml', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml', rel: `${REL}/styles`, id: 'rId1' },
  { path: 'word/numbering.xml', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml', rel: `${REL}/numbering`, id: 'rId2' },
  { path: 'word/settings.xml', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml', rel: `${REL}/settings`, id: 'rId3' },
  { path: 'word/fontTable.xml', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml', rel: `${REL}/fontTable`, id: 'rId4' },
  { path: 'word/theme/theme1.xml', type: 'application/vnd.openxmlformats-officedocument.theme+xml', rel: `${REL}/theme`, id: 'rId5' },
  { path: 'word/footer1.xml', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml', rel: `${REL}/footer`, id: 'rId6' },
]);

const FOOTER_ID = 'rId6';

// ---------------------------------------------------------------------------
// Inline markdown
// ---------------------------------------------------------------------------

/** @typedef {{text: string, bold?: boolean, italic?: boolean, link?: string}} Run */

function isWs(c) {
  return c == null || /\s/u.test(c);
}

function isPunct(c) {
  return c != null && /[\p{P}\p{S}]/u.test(c);
}

/** CommonMark left-flanking delimiter run at [start, end). */
function isLeftFlanking(src, start, end) {
  const prev = start > 0 ? src[start - 1] : null;
  const next = end < src.length ? src[end] : null;
  if (isWs(next)) return false;
  return !isPunct(next) || isWs(prev) || isPunct(prev);
}

/** CommonMark right-flanking delimiter run at [start, end). */
function isRightFlanking(src, start, end) {
  const prev = start > 0 ? src[start - 1] : null;
  const next = end < src.length ? src[end] : null;
  if (isWs(prev)) return false;
  return !isPunct(prev) || isWs(next) || isPunct(next);
}

function canOpenEmphasis(src, start, end, char) {
  if (!isLeftFlanking(src, start, end)) return false;
  if (char === '_') {
    return !isRightFlanking(src, start, end) || isPunct(start > 0 ? src[start - 1] : null);
  }
  return true;
}

function canCloseEmphasis(src, start, end, char) {
  if (!isRightFlanking(src, start, end)) return false;
  if (char === '_') {
    return !isLeftFlanking(src, start, end) || isPunct(end < src.length ? src[end] : null);
  }
  return true;
}

function findEmphasisClose(src, marker, from) {
  let i = from;
  while (i < src.length) {
    if (src[i] === '\\' && i + 1 < src.length) { i += 2; continue; }
    if (src.startsWith(marker, i)) {
      if (marker.length === 1 && src[i + 1] === marker) { i += 2; continue; }
      const end = i + marker.length;
      if (canCloseEmphasis(src, i, end, marker[0])) return i;
      i = end;
      continue;
    }
    i += 1;
  }
  return -1;
}

/**
 * Parse `**bold**`, `__bold__`, `*italic*`, `_italic_`, `[text](url)`,
 * `` `code` `` and backslash escapes into runs. `_` / `__` follow CommonMark
 * flanking (no intra-word emphasis). A `*` closer cannot be preceded by a
 * space. A link target may contain one pair of parentheses. Anything else is
 * literal text.
 *
 * @param {string} src
 * @param {Partial<Run>} [base]
 * @returns {Run[]}
 */
export function parseInline(src, base = {}) {
  const runs = [];
  let buf = '';
  const flush = () => { if (buf) { runs.push({ ...base, text: buf }); buf = ''; } };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!|<>~]/.test(src[i + 1])) {
      buf += src[i + 1]; i += 2; continue;
    }
    if (c === '`') {
      const j = src.indexOf('`', i + 1);
      if (j > i + 1) { buf += src.slice(i + 1, j); i = j + 1; continue; }
    }
    if (src.startsWith('**', i) || src.startsWith('__', i)) {
      const marker = src.startsWith('**', i) ? '**' : '__';
      if (canOpenEmphasis(src, i, i + 2, marker[0])) {
        const j = findEmphasisClose(src, marker, i + 2);
        if (j > i + 2) { flush(); runs.push(...parseInline(src.slice(i + 2, j), { ...base, bold: true })); i = j + 2; continue; }
      }
    }
    if ((c === '*' || c === '_') && src[i + 1] !== c) {
      if (canOpenEmphasis(src, i, i + 1, c)) {
        const j = findEmphasisClose(src, c, i + 1);
        if (j > i + 1) {
          flush();
          runs.push(...parseInline(src.slice(i + 1, j), { ...base, italic: true }));
          i = j + 1;
          continue;
        }
      }
    }
    if (c === '[') {
      // One nested pair, so a Wikipedia title such as Foo_(bar) stays intact.
      const m = /^\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)/.exec(src.slice(i));
      if (m && m[1]) { flush(); runs.push(...parseInline(m[1], { ...base, link: m[2] })); i += m[0].length; continue; }
    }
    buf += c; i += 1;
  }
  flush();
  return runs;
}

/** Plain visible text of an inline string (markers removed). */
export function inlineText(src) {
  return parseInline(src).map((r) => r.text).join('');
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

const DATE_LINE_RE = /(?:\b(?:19|20)\d{2}\b|\bpresent\b|\bcurrent\b)/i;
const DATE_WORD_RE = /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|present|current|spring|summer|fall|autumn|winter|expected|anticipated)$/i;

function isDateLine(plain) {
  if (plain.length > 60 || /[.!?]$/.test(plain) || !DATE_LINE_RE.test(plain)) return false;
  const leftover = plain
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}\b/g, ' ')
    .split(/[^A-Za-z]+/)
    .filter((word) => word && !DATE_WORD_RE.test(word));
  return leftover.length === 0;
}

function plainOf(line) {
  return inlineText(line).trim();
}

/** @returns {'bold'|'label'|'dates'|'plain'} */
function classify(line) {
  const t = line.trim();
  // A date line is a date even when the whole line is wrapped in bold or italic.
  // Emphasis is dropped when the date is rendered, so it cannot become a title.
  if (isDateLine(plainOf(t))) return 'dates';
  if (/^\*\*[^*]+\*\*$/.test(t) || /^__[^_]+__$/.test(t)) return 'bold';
  if (/^\*\*[^*:]+:\*\*(?:\s|$)/.test(t) || /^\*\*[^*:]+\*\*:(?:\s|$)/.test(t)) return 'label';
  return 'plain';
}

/**
 * @typedef {{type: 'heading', level: number, text: string}
 *   | {type: 'bullet', level: number, text: string}
 *   | {type: 'para', text: string, kind: 'bold'|'label'|'dates'|'plain'}} Block
 */

function stripHtmlCommentsKeepNewlines(input) {
  let s = String(input);
  let prev;
  do {
    prev = s;
    s = s.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''));
  } while (s !== prev);
  return s;
}

/**
 * Split markdown into blocks, refusing anything the renderer cannot honour.
 *
 * @param {string} markdown
 * @returns {Block[]}
 */
export function parseBlocks(markdown) {
  const text = stripHtmlCommentsKeepNewlines(String(markdown ?? '').replace(/\r\n?/g, '\n'));
  const lines = text.split('\n');
  /** @type {Block[]} */
  const blocks = [];
  let last = null; // 'bullet' | 'para' | null (null after a blank or a heading)
  let hardBreak = false;

  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n];
    const where = `line ${n + 1}`;
    if (!raw.trim()) { last = null; hardBreak = false; continue; }
    const normalized = normalizePandocLine(raw);
    if (/^\s*```|^\s*~~~/.test(normalized)) throw new Error(`Unsupported markdown (code fence) at ${where}`);
    if (/^\s*\|/.test(normalized)) throw new Error(`Unsupported markdown (table) at ${where}`);
    if (/^\s*!\[/.test(normalized)) throw new Error(`Unsupported markdown (image) at ${where}`);
    if (/^\s*>/.test(normalized)) throw new Error(`Unsupported markdown (blockquote) at ${where}`);
    const numbered = /^\s*(\d+)[.)]\s+/.exec(normalized);
    // A wrapped line that starts with a year (`2024. Then…`) is prose, not a
    // list. Only refuse a short marker after a blank/heading or another item.
    if (numbered && numbered[1].length < 4 && (last === null || last === 'bullet')) {
      throw new Error(`Unsupported markdown (numbered list) at ${where}`);
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(normalized)) { last = null; continue; }

    const trimmed = normalized.trim();
    const levelMatch = /^(#{1,6})(?=\s)/.exec(trimmed);
    if (levelMatch) {
      blocks.push({ type: 'heading', level: levelMatch[1].length, text: headingText(trimmed, levelMatch[1].length) ?? '' });
      last = null; hardBreak = false; continue;
    }

    const bullet = /^(\s*)[-*+•]\s+(.*)$/.exec(normalized);
    if (bullet) {
      blocks.push({ type: 'bullet', level: bullet[1].replace(/\t/g, '  ').length >= 2 ? 1 : 0, text: bullet[2].trim() });
      last = 'bullet'; hardBreak = false; continue;
    }

    const endsBreak = /\\\s*$|\s{2,}$/.test(raw);
    const line = trimmed;
    const prev = blocks[blocks.length - 1];

    // A text line directly under a bullet continues it (markdown lazy continuation).
    if (last === 'bullet' && prev?.type === 'bullet') {
      prev.text = `${prev.text} ${line}`;
      hardBreak = endsBreak;
      continue;
    }
    const kind = classify(line);
    if (last === 'para' && prev?.type === 'para' && !hardBreak && kind === 'plain' && prev.kind === 'plain') {
      prev.text = `${prev.text} ${line}`;
    } else {
      blocks.push({ type: 'para', text: line, kind });
      last = 'para';
    }
    hardBreak = endsBreak;
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Document model
// ---------------------------------------------------------------------------

/**
 * @typedef {{type: 'entry', heading: string, title: string|null, dates: string|null}
 *   | {type: 'bullet', level: number, text: string}
 *   | {type: 'para', text: string}} Item
 * @typedef {{title: string, items: Item[]}} Section
 * @typedef {{name: string, dropped: string[], contact: {label: string, value: string}[], extra: string[], sections: Section[]}} ResumeModel
 */

const NAME_PREFIX_RE = /^CV\s*(?:--|—|–|-|:)\s*/i;
const SEPARATOR_RE = /\s+(?:—|–|--|-)\s+/;

/**
 * @param {string} markdown
 * @returns {ResumeModel}
 */
export function parseResume(markdown) {
  const blocks = parseBlocks(markdown);
  const first = blocks.findIndex((b) => b.type === 'heading' && b.level === 1);
  if (first < 0) throw new Error('No "# Name" heading found: the first heading must be the candidate name');
  if (blocks.slice(0, first).some((b) => b.type !== 'heading' || b.level !== 1)) {
    throw new Error('Content found before the "# Name" heading');
  }
  const nameBlock = /** @type {{text: string}} */ (blocks[first]);
  const rawName = nameBlock.text;
  const name = inlineText(rawName).replace(NAME_PREFIX_RE, '').trim();
  if (!name) throw new Error('The "# Name" heading is empty');
  const dropped = [];
  const prefix = NAME_PREFIX_RE.exec(inlineText(rawName));
  if (prefix) dropped.push(prefix[0]);

  /** @type {ResumeModel} */
  const model = { name, dropped, contact: [], extra: [], sections: [] };
  let i = first + 1;
  for (; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === 'heading') break;
    if (b.type === 'para' && b.kind === 'label') {
      const m = /^\*\*([^*:]+):?\*\*:?\s*(.*)$/.exec(b.text);
      if (m && m[2]) {
        model.contact.push({ label: m[1].trim(), value: m[2].trim() });
        dropped.push(`${m[1].trim()}:`);
        continue;
      }
    }
    model.extra.push(b.type === 'bullet' ? b.text : b.text);
  }

  /** @type {Section|null} */
  let section = null;
  const rest = blocks.slice(i);
  for (let k = 0; k < rest.length; k++) {
    const b = rest[k];
    if (b.type === 'heading' && b.level === 1) {
      throw new Error(`Unexpected "#" heading "${inlineText(b.text).trim()}": only the first heading may be level 1`);
    }
    if (b.type === 'heading' && b.level === 2) {
      section = { title: b.text, items: [] };
      model.sections.push(section);
      continue;
    }
    if (!section) throw new Error('Content found before the first "## Section" heading');
    if (b.type === 'heading') {
      let title = null;
      let dates = null;
      const t = rest[k + 1];
      if (t && t.type === 'para' && t.kind === 'bold') { title = t.text.replace(/^(\*\*|__)|(\*\*|__)$/g, ''); k += 1; }
      const d = rest[k + 1];
      if (d && d.type === 'para' && d.kind === 'dates') { dates = d.text; k += 1; }
      section.items.push({ type: 'entry', heading: b.text, title, dates });
    } else if (b.type === 'bullet') {
      section.items.push({ type: 'bullet', level: b.level, text: b.text });
    } else {
      section.items.push({ type: 'para', text: b.text });
    }
  }
  return model;
}

// ---------------------------------------------------------------------------
// WordprocessingML
// ---------------------------------------------------------------------------

function upperForHeading(s) {
  return s.replace(/ß/g, 'ẞ').toUpperCase();
}

function esc(s) {
  return String(s)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function safeHref(url) {
  const u = String(url).trim();
  if (/^(?:https?:|mailto:)/i.test(u)) return u;
  return null;
}

/**
 * Collects hyperlink relationships while paragraphs are rendered.
 */
class Links {
  constructor() { this.items = []; }
  /** @param {string} href @returns {string} relationship id */
  add(href) {
    const found = this.items.find((l) => l.href === href);
    if (found) return found.id;
    const id = `rId${100 + this.items.length}`;
    this.items.push({ id, href });
    return id;
  }
}

/**
 * @param {Run[]} runs
 * @param {Links} links
 * @param {{size?: number, upper?: boolean, bold?: boolean}} [opts]
 */
function runsXml(runs, links, opts = {}) {
  let out = '';
  const size = opts.size ?? LAYOUT.bodySize;
  const fonts = `<w:rFonts w:ascii="${LAYOUT.font}" w:hAnsi="${LAYOUT.font}" w:cs="${LAYOUT.font}"/>`;
  for (const run of runs) {
    const href = run.link ? safeHref(run.link) : null;
    let rpr = href ? '<w:rStyle w:val="Hyperlink"/>' : '';
    rpr += fonts;
    if (run.bold || opts.bold) rpr += '<w:b/>';
    if (run.italic) rpr += '<w:i/>';
    rpr += `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`;
    const text = opts.upper ? upperForHeading(run.text) : run.text;
    const r = `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
    out += href ? `<w:hyperlink r:id="${links.add(href)}" w:history="1">${r}</w:hyperlink>` : r;
  }
  return out;
}

const RULE = `<w:pBdr><w:bottom w:val="single" w:sz="${LAYOUT.ruleSize}" w:space="1" w:color="000000"/></w:pBdr>`;
const SPACING_BODY = `<w:spacing w:before="0" w:after="0" w:line="${LAYOUT.lineSpacing}" w:lineRule="auto"/>`;

function para(ppr, content) {
  return `<w:p><w:pPr>${ppr}</w:pPr>${content}</w:p>`;
}

function contactRuns(contact) {
  const runs = [];
  contact.forEach((item, idx) => {
    if (idx > 0) runs.push({ text: ' | ' });
    let parts = parseInline(item.value);
    if (!parts.some((r) => r.link)) {
      const plain = parts.map((r) => r.text).join('').trim();
      if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(plain)) parts = [{ text: plain, link: `mailto:${plain}` }];
      else if (!/^(?:location|phone|mobile|tel|address)$/i.test(item.label)
        && /^(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?$/i.test(plain)) {
        parts = [{ text: plain, link: /^https?:/i.test(plain) ? plain : `https://${plain}` }];
      }
    }
    runs.push(...parts);
  });
  return runs;
}

function entryXml(item, links) {
  const sep = SEPARATOR_RE.exec(item.heading);
  const left = sep ? item.heading.slice(0, sep.index) : item.heading;
  const right = sep ? item.heading.slice(sep.index + sep[0].length) : '';
  const noBold = (runs) => runs.map((r) => ({ ...r, bold: false }));
  let runs;
  if (item.title) {
    runs = [...parseInline(item.title, { bold: true }), { text: ' | ' }, ...noBold(parseInline(left))];
    if (right) runs.push({ text: ', ' }, ...noBold(parseInline(right)));
  } else {
    runs = [...parseInline(left, { bold: true })];
    if (right) runs.push({ text: ' | ' }, ...noBold(parseInline(right)));
  }
  let content = runsXml(runs, links);
  let tabs = '';
  if (item.dates) {
    const dates = inlineText(item.dates).replace(/^\((.*)\)$/, '$1').trim();
    tabs = `<w:tabs><w:tab w:val="right" w:pos="${LAYOUT.textWidth}"/></w:tabs>`;
    content += `<w:r><w:tab/></w:r>${runsXml([{ text: '(' }], links)}${runsXml([{ text: `${dates})`, italic: true }], links)}`;
  }
  return para(
    `<w:keepNext/><w:widowControl w:val="0"/>${tabs}<w:spacing w:before="${LAYOUT.entryBefore}" w:after="0" w:line="${LAYOUT.lineSpacing}" w:lineRule="auto"/><w:ind w:left="0"/>`,
    content,
  );
}

/**
 * @param {ResumeModel} model
 * @returns {{xml: string, links: {id: string, href: string}[]}}
 */
export function renderDocumentXml(model) {
  const links = new Links();
  const body = [];

  body.push(para(
    `<w:keepNext/><w:widowControl w:val="0"/>${RULE}${SPACING_BODY}<w:ind w:left="0"/><w:jc w:val="center"/>`,
    runsXml([{ text: model.name, bold: true }], links, { size: LAYOUT.nameSize }),
  ));
  if (model.contact.length) {
    body.push(para(
      `<w:widowControl w:val="0"/>${RULE}${SPACING_BODY}<w:ind w:left="0"/><w:jc w:val="center"/>`,
      runsXml(contactRuns(model.contact), links),
    ));
  }
  for (const line of model.extra) {
    body.push(para(`<w:widowControl w:val="0"/>${SPACING_BODY}<w:ind w:left="0"/><w:jc w:val="center"/>`, runsXml(parseInline(line), links)));
  }

  for (const section of model.sections) {
    body.push(para(
      `<w:keepNext/><w:widowControl w:val="0"/>${RULE}<w:spacing w:before="${LAYOUT.sectionBefore}" w:after="0" w:line="${LAYOUT.lineSpacing}" w:lineRule="auto"/><w:ind w:left="0"/>`,
      runsXml(parseInline(section.title, { bold: true }), links, { upper: true }),
    ));
    const isSkills = /\bskills$/i.test(inlineText(section.title).trim());
    for (const item of section.items) {
      if (item.type === 'entry') {
        body.push(entryXml(item, links));
      } else if (item.type === 'bullet' && isSkills) {
        body.push(para(
          `<w:widowControl w:val="0"/><w:spacing w:before="0" w:after="${LAYOUT.skillsAfter}" w:line="${LAYOUT.lineSpacing}" w:lineRule="auto"/><w:ind w:left="${item.level ? LAYOUT.bulletLeft : 0}"/>`,
          runsXml(parseInline(item.text), links, { size: LAYOUT.skillsSize }),
        ));
      } else if (item.type === 'bullet') {
        body.push(para(
          `<w:widowControl w:val="0"/><w:numPr><w:ilvl w:val="${item.level}"/><w:numId w:val="1"/></w:numPr>${SPACING_BODY}`,
          runsXml(parseInline(item.text), links),
        ));
      } else {
        body.push(para(
          `<w:widowControl w:val="0"/>${SPACING_BODY}<w:ind w:left="${LAYOUT.bodyIndent}"/>`,
          runsXml(parseInline(item.text), links, isSkills ? { size: LAYOUT.skillsSize } : {}),
        ));
      }
    }
  }

  const sect = `<w:sectPr><w:footerReference w:type="default" r:id="${FOOTER_ID}"/>`
    + `<w:pgSz w:w="${LAYOUT.pageWidth}" w:h="${LAYOUT.pageHeight}"/>`
    + `<w:pgMar w:top="${LAYOUT.marginTop}" w:right="${LAYOUT.marginRight}" w:bottom="${LAYOUT.marginBottom}" w:left="${LAYOUT.marginLeft}" w:header="720" w:footer="${LAYOUT.footerDistance}" w:gutter="0"/></w:sectPr>`;
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
    + `<w:document xmlns:w="${NS_W}" xmlns:r="${NS_R}"><w:body>${body.join('')}${sect}</w:body></w:document>\n`;
  return { xml, links: links.items };
}

// ---------------------------------------------------------------------------
// Package
// ---------------------------------------------------------------------------

/**
 * Build the .docx bytes for a tailored resume markdown.
 *
 * @param {string} markdown
 * @param {{readTemplatePart: (path: string) => Buffer|string}} opts
 * @returns {{buffer: Buffer, model: ResumeModel}}
 */
export function buildDocx(markdown, { readTemplatePart }) {
  const model = parseResume(markdown);
  const { xml, links } = renderDocumentXml(model);

  const rels = TEMPLATE_PARTS.map((p) => `<Relationship Id="${p.id}" Type="${p.rel}" Target="${p.path.replace(/^word\//, '')}"/>`);
  for (const l of links) {
    rels.push(`<Relationship Id="${l.id}" Type="${REL}/hyperlink" Target="${esc(l.href).replace(/"/g, '&quot;')}" TargetMode="External"/>`);
  }
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>\n`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>\n`;
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + TEMPLATE_PARTS.map((p) => `<Override PartName="/${p.path}" ContentType="${p.type}"/>`).join('')
    + '</Types>\n';

  const entries = [
    { name: '[Content_Types].xml', data: types },
    { name: '_rels/.rels', data: rootRels },
    { name: 'word/document.xml', data: xml },
    { name: 'word/_rels/document.xml.rels', data: docRels },
    ...TEMPLATE_PARTS.map((p) => ({ name: p.path, data: readTemplatePart(p.path) })),
  ];
  return { buffer: writeZip(entries), model };
}

// ---------------------------------------------------------------------------
// Reading back
// ---------------------------------------------------------------------------

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

/** @param {string} s @returns {string[]} lowercase letter/digit words */
export function words(s) {
  return (String(s).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/** Remove HTML comments with repeated passes until no more can be removed. */
function stripHtmlCommentsStable(input) {
  let s = String(input);
  let prev;
  do {
    prev = s;
    s = s.replace(/<!--[\s\S]*?-->/g, '');
  } while (s !== prev);
  return s;
}

/**
 * Strip markdown markers without going through parseInline, so a parser bug
 * cannot hide from the round-trip check. Deliberately simpler: `__` / `_`
 * only unwrap when they are not intra-word, and a `*` closer cannot follow
 * a space.
 */
export function stripInlineMarkers(src) {
  let s = String(src ?? '');
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, '$1');
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/\[([^\]]+)\]\((?:[^()\s]|\([^()\s]*\))+(?:\s+"[^"]*")?\)/g, '$1');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/(^|[^\p{L}\p{N}_])__([^_]+)__(?![\p{L}\p{N}_])/gu, '$1$2');
  s = s.replace(/\*(\S(?:(?!\s\*).)*?)\*/g, '$1');
  s = s.replace(/(^|[^\p{L}\p{N}_])_([^_]+)_(?![\p{L}\p{N}_])/gu, '$1$2');
  return s;
}

/** Visible text of one source line, after the same normalization the parser uses. */
function visibleSourceLine(line) {
  const normalized = normalizePandocLine(line);
  const trimmed = normalized.trim();
  const levelMatch = /^(#{1,6})(?=\s)/.exec(trimmed);
  if (levelMatch) return stripInlineMarkers(headingText(trimmed, levelMatch[1].length) ?? '');
  const bullet = /^(\s*)[-*+•]\s+(.*)$/.exec(normalized);
  if (bullet) return stripInlineMarkers(bullet[2].trim());
  return stripInlineMarkers(trimmed);
}

/** Visible words of the source markdown, with link targets and markers removed. */
function markdownWords(markdown) {
  const text = stripHtmlCommentsStable(String(markdown).replace(/\r\n?/g, '\n'))
    .split('\n')
    .filter((l) => !/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(l))
    .map(visibleSourceLine)
    .join('\n');
  return words(text);
}

/**
 * Compare the words of the markdown with the words in the .docx. Both
 * directions are checked: a word the document gained is as much a defect as a
 * word it lost. Source words come from stripInlineMarkers(), not parseInline(),
 * so a parser bug cannot hide by landing on both sides. The layout-only
 * differences the renderer introduces (the dropped `CV --` prefix and contact
 * labels) are removed from the markdown side first.
 *
 * @param {string} markdown
 * @param {Buffer} docx
 * @param {ResumeModel} model
 * @returns {{ok: boolean, missing: string[], extra: string[]}}
 */
export function compareContent(markdown, docx, model) {
  const source = markdownWords(markdown);
  for (const w of model.dropped.flatMap(words)) {
    const idx = source.indexOf(w);
    if (idx >= 0) source.splice(idx, 1);
  }
  const target = extractDocxParagraphs(docx).flatMap(words);
  const count = (arr) => arr.reduce((m, w) => m.set(w, (m.get(w) ?? 0) + 1), new Map());
  const a = count(source);
  const b = count(target);
  const missing = [];
  const extra = [];
  for (const [w, n] of a) for (let k = (b.get(w) ?? 0); k < n; k++) missing.push(w);
  for (const [w, n] of b) for (let k = (a.get(w) ?? 0); k < n; k++) extra.push(w);
  return { ok: !missing.length && !extra.length, missing, extra };
}
