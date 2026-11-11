import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDocx } from '../generate-docx.mjs';
import { crc32, readZip, writeZip } from '../lib/docx-zip.mjs';
import {
  LAYOUT, TEMPLATE_PARTS, buildDocx, compareContent, extractDocxParagraphs, pageLengthWarning, parseBlocks, parseInline, parseResume, stripInlineMarkers, words,
} from '../lib/docx-resume.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_DIR = join(ROOT, 'templates', 'docx', 'garamond');
const readTemplatePart = (p) => readFileSync(join(TEMPLATE_DIR, p));

function realOrSelf(p) {
  try { return realpathSync(p); } catch { return resolve(p); }
}

function isInside(root, target) {
  const r = resolve(root);
  const t = resolve(target);
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * A directory the generator must refuse: not the project, not the data root,
 * and not os.tmpdir(). Hard-coding `/tmp` fails both ways — Windows has no
 * `/tmp`, and on Linux `tmpdir()` *is* `/tmp`, so a write there is allowed.
 */
const outsideDirsCreated = [];

function mkdtempOutsideAllowed(prefix = 'career-ops-docx-outside-') {
  const allowed = [ROOT, getCareerOpsRoot(), tmpdir()].map(realOrSelf);
  const errors = [];
  for (const base of [resolve(tmpdir(), '..'), resolve(ROOT, '..'), homedir()]) {
    try {
      const dir = mkdtempSync(join(base, prefix));
      const real = realOrSelf(dir);
      if (allowed.some((root) => isInside(root, real))) {
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      outsideDirsCreated.push(dir);
      return dir;
    } catch (error) {
      errors.push(`${base}: ${error.message}`);
    }
  }
  throw new Error(`could not create a temp dir outside allowed write roots (${errors.join('; ')})`);
}

after(() => {
  for (const dir of outsideDirsCreated) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'docx-cli-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MD = `# CV -- Jane Smith

**Location:** Singapore
**Email:** jane@example.com
**LinkedIn:** linkedin.com/in/janesmith

## Professional Summary

Builds things & ships a < b software.

## Work Experience

### Acme Corp -- Toronto, ON

**Software Engineer**
Jan 2026 – Present

- Built **parsers** for *messy* data
- Cut cost by 10%

## Projects

### Tracker — Job tracker (personal)
Mar – Apr 2025

- Wrote it in [TypeScript](https://example.com/ts)

## Skills

- **Languages:** Python, TypeScript
- **Tools:** Git, Playwright
`;

function build(md) {
  return buildDocx(md, { readTemplatePart });
}

function documentXml(buffer) {
  return readZip(buffer).get('word/document.xml').toString('utf8');
}

test('zip: round-trips entries, is deterministic, and checks the CRC', () => {
  const entries = [
    { name: 'a.txt', data: 'hello hello hello hello hello hello' },
    { name: 'dir/b.bin', data: Buffer.from([1, 2, 3]) },
  ];
  const first = writeZip(entries);
  assert.deepEqual(first, writeZip(entries), 'same input must give the same bytes');
  const parts = readZip(first);
  assert.equal(parts.get('a.txt').toString(), 'hello hello hello hello hello hello');
  assert.deepEqual([...parts.get('dir/b.bin')], [1, 2, 3]);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const corrupt = Buffer.from(first);
  corrupt[40] ^= 0xff;
  assert.throws(() => readZip(corrupt));
});

test('zip: refuses an unsafe entry name', () => {
  for (const name of ['', '../evil', '/abs', 'foo/../../etc', 'foo\\bar', 'C:/windows', 'a\0b']) {
    assert.throws(() => writeZip([{ name, data: 'x' }]), /Unsafe zip entry name/, JSON.stringify(name));
  }
});

test('zip: a file that is not a zip, a truncated zip, and a damaged directory are refused', () => {
  assert.throws(() => readZip(Buffer.alloc(0)), /Not a zip file/);
  assert.throws(() => readZip(Buffer.from('this is not a zip')), /Not a zip file/);
  const valid = writeZip([{ name: 'a.txt', data: 'hello hello hello hello hello hello' }]);
  assert.throws(() => readZip(valid.subarray(0, 20)), /Not a zip file|Corrupt zip/);

  const badCrc = Buffer.from(valid);
  const central = badCrc.readUInt32LE(badCrc.length - 22 + 16);
  badCrc[central + 16] ^= 0xff;
  assert.throws(() => readZip(badCrc), /checksum mismatch/);

  const badMethod = Buffer.from(valid);
  badMethod.writeUInt16LE(99, central + 10);
  assert.throws(() => readZip(badMethod), /Unsupported zip compression method 99/);

  const badCentral = Buffer.from(valid);
  badCentral[central] ^= 0xff;
  assert.throws(() => readZip(badCentral), /Corrupt zip: bad central directory entry/);
});

test('inline: bold, italic, links, code and escapes', () => {
  const runs = parseInline('a **b** __u__ *c* [d](https://x.test) `e` \\*f\\* a \\b');
  assert.deepEqual(runs.map((r) => r.text).join(''), 'a b u c d e *f* a \\b');
  assert.equal(runs.find((r) => r.text === 'b').bold, true);
  assert.equal(runs.find((r) => r.text === 'u').bold, true);
  assert.equal(runs.find((r) => r.text === 'c').italic, true);
  assert.equal(runs.find((r) => r.text === 'd').link, 'https://x.test');
  assert.deepEqual(parseInline('a **b c').map((r) => r.text).join(''), 'a **b c');
  const linked = parseInline('[**Parsers**](https://example.com/ts)');
  assert.equal(linked[0].text, 'Parsers');
  assert.equal(linked[0].bold, true);
  assert.equal(linked[0].link, 'https://example.com/ts');
  const wiki = parseInline('[Wiki](https://en.wikipedia.org/wiki/Foo_(bar))');
  assert.equal(wiki[0].text, 'Wiki');
  assert.equal(wiki[0].link, 'https://en.wikipedia.org/wiki/Foo_(bar)');
});

test('inline: a triple-star run is bold italic', () => {
  const runs = parseInline('***Led*** the team');
  assert.equal(runs[0].text, 'Led');
  assert.equal(runs[0].bold, true);
  assert.equal(runs[0].italic, true);
  assert.equal(runs.map((r) => r.text).join(''), 'Led the team');
  assert.equal(stripInlineMarkers('***Led*** the team'), 'Led the team');
  const md = '# Jane\n\n## Work\n\n- ***Led*** the team\n';
  const built = build(md);
  const paragraphs = extractDocxParagraphs(built.buffer);
  assert.ok(paragraphs.some((p) => p.includes('Led') && !p.includes('*Led*')), paragraphs.join('\n'));
  assert.deepEqual(compareContent(md, built.buffer, built.model), { ok: true, missing: [], extra: [] });
});

test('inline: ***Led** team* is italic with bold Led', () => {
  const runs = parseInline('***Led** team*');
  assert.equal(runs.map((r) => r.text).join(''), 'Led team');
  assert.equal(runs[0].text, 'Led');
  assert.equal(runs[0].bold, true);
  assert.equal(runs[0].italic, true);
  assert.equal(runs.some((r) => r.text.includes('team') && r.italic && !r.bold), true);
  assert.equal(stripInlineMarkers('***Led** team*'), 'Led team');
  const md = '# Jane\n\n## Work\n\n- ***Led** team*\n';
  const built = build(md);
  const paragraphs = extractDocxParagraphs(built.buffer);
  assert.ok(paragraphs.some((p) => p.includes('Led') && p.includes('team') && !p.includes('*')), paragraphs.join('\n'));
  assert.deepEqual(compareContent(md, built.buffer, built.model), { ok: true, missing: [], extra: [] });
});

test('B3: my__var__name and *nix and *BSD stay unflanked', () => {
  assert.equal(parseInline('my__var__name and __init__').map((r) => r.text).join(''), 'my__var__name and init');
  assert.equal(parseInline('my__var__name').map((r) => r.text).join(''), 'my__var__name');
  assert.equal(parseInline('*nix and *BSD').map((r) => r.text).join(''), '*nix and *BSD');
  assert.equal(stripInlineMarkers('my__var__name and __init__'), 'my__var__name and init');
  assert.equal(stripInlineMarkers('*nix and *BSD'), '*nix and *BSD');
  const md = '# Jane\n\n## Work\n\n- my__var__name and __init__\n- *nix and *BSD\n';
  const built = build(md);
  const paragraphs = extractDocxParagraphs(built.buffer);
  assert.ok(paragraphs.some((p) => p.includes('my__var__name')), paragraphs.join('\n'));
  assert.ok(paragraphs.some((p) => p.includes('*nix') && p.includes('*BSD')), paragraphs.join('\n'));
  assert.deepEqual(compareContent(md, built.buffer, built.model), { ok: true, missing: [], extra: [] });
});

test('words: NFKC so a ligature matches its letters', () => {
  assert.deepEqual(words('ﬁle'), ['file']);
});

test('blocks: refuses tables, code fences, images, blockquotes and numbered lists', () => {
  for (const bad of ['| a | b |', '```js', '![x](y.png)', '> quote', '1. First', '2) Second']) {
    assert.throws(() => parseBlocks(`# N\n\n## S\n\n${bad}\n`), /Unsupported markdown/, bad);
  }
});

test('blocks: a numbered list after a paragraph is refused', () => {
  assert.throws(
    () => parseBlocks('# Jane\n\n## Work\n\nKey wins:\n1. Shipped X\n2. Cut cost 30%\n'),
    /Unsupported markdown \(numbered list\)/,
  );
});

test('blocks: refuses raw inline HTML', () => {
  assert.throws(
    () => parseBlocks('# Jane\n\n## Work\n\n- Line one<br>line two\n'),
    /Unsupported markdown \(HTML\)/,
  );
  assert.throws(
    () => parseBlocks('# Jane\n\n## Work\n\n- <div>block</div>\n'),
    /Unsupported markdown \(HTML\)/,
  );
});

test('blocks: generics and code-span tags are not HTML', () => {
  for (const ok of ['C++ <T>', 'List<String>', 'std::vector<int>', 'uses `<div>` in docs', '<3', 'a < b > c', '<jane@x.com>', '<50ms']) {
    assert.doesNotThrow(() => parseBlocks(`# Jane\n\n## Work\n\n- ${ok}\n`), ok);
  }
});

test('blocks: refuses empty link text', () => {
  assert.throws(
    () => parseBlocks('# Jane\n\n## Work\n\n[](https://x.com)\n'),
    /Unsupported markdown \(empty link text\)/,
  );
  assert.throws(
    () => parseBlocks('# Jane\n\n## Work\n\n[ ](https://x.com)\n'),
    /Unsupported markdown \(empty link text\)/,
  );
});

test('inline: autolinks become hyperlinks', () => {
  const url = parseInline('see <https://x.com> now');
  assert.equal(url.map((r) => r.text).join(''), 'see https://x.com now');
  assert.equal(url.find((r) => r.text === 'https://x.com').link, 'https://x.com');
  const mail = parseInline('write <me@x.com> please');
  assert.equal(mail.map((r) => r.text).join(''), 'write me@x.com please');
  assert.equal(mail.find((r) => r.text === 'me@x.com').link, 'mailto:me@x.com');
  const md = '# Jane\n\n## Work\n\n- see <https://x.com> and <me@x.com>\n';
  const built = build(md);
  const rels = readZip(built.buffer).get('word/_rels/document.xml.rels').toString();
  assert.match(rels, /Target="https:\/\/x.com"/);
  assert.match(rels, /Target="mailto:me@x.com"/);
  assert.deepEqual(compareContent(md, built.buffer, built.model), { ok: true, missing: [], extra: [] });
});

test('blocks: rules, comments, wrapped lines and Windows newlines', () => {
  const blocks = parseBlocks('# Jane\r\n\r\n---\r\n\r\n## Work\r\n\r\n- Built parsers\r\n  for messy data\r\n  - nested\r\n\r\n<!-- secretword -->\r\n');
  assert.equal(blocks.some((b) => b.text?.includes('---') || b.text?.includes('secretword')), false);
  const bullets = blocks.filter((b) => b.type === 'bullet');
  assert.equal(bullets[0].text, 'Built parsers for messy data');
  assert.equal(bullets[0].level, 0);
  assert.equal(bullets[1].text, 'nested');
  assert.equal(bullets[1].level, 1);
  const built = build('# Jane\n\n## Work\n\n- Built parsers\n  for messy data\n\n<!-- secretword -->\n');
  assert.equal(compareContent('# Jane\n\n## Work\n\n- Built parsers\n  for messy data\n\n<!-- secretword -->\n', built.buffer, built.model).ok, true);
  assert.equal(extractDocxParagraphs(built.buffer).some((p) => p.includes('secretword')), false);
});

test('blocks: a wrapped line that starts with a year is prose, not a numbered list', () => {
  const blocks = parseBlocks('# Jane\n\n## Work\n\n- Shipped it.\n  2024. Then scaled it.\n');
  assert.equal(blocks.filter((b) => b.type === 'bullet')[0].text, 'Shipped it. 2024. Then scaled it.');
  assert.doesNotThrow(() => parseBlocks('# Jane\n\n## Work\n\nHello.\n2024. Then more.\n'));
});

test('model: heading words and section order follow the markdown exactly', () => {
  const model = parseResume(MD);
  assert.equal(model.name, 'Jane Smith');
  assert.deepEqual(model.sections.map((s) => s.title), ['Professional Summary', 'Work Experience', 'Projects', 'Skills']);
  assert.deepEqual(model.contact.map((c) => c.label), ['Location', 'Email', 'LinkedIn']);
});

test('model: an empty section keeps its heading and adds nothing under it', () => {
  const md = '# Jane\n\n## Certifications\n\n## Skills\n\n- **Go:** yes\n';
  const built = build(md);
  assert.deepEqual(built.model.sections.map((s) => [s.title, s.items.length]), [['Certifications', 0], ['Skills', 1]]);
  const paragraphs = extractDocxParagraphs(built.buffer);
  const cert = paragraphs.indexOf('CERTIFICATIONS');
  const skills = paragraphs.indexOf('SKILLS');
  assert.ok(cert > 0 && skills === cert + 1, paragraphs.join('\n'));
  assert.equal(compareContent(md, built.buffer, built.model).ok, true);
});

test('model: sections render in an arbitrary order, with their own wording', () => {
  const md = '# A B\n\n## Education\n\n- X University\n\n## Skills\n\n- **Go:** yes\n\n## Professional Summary\n\nHello there.\n\n## Extracurricular\n\n- Chess club\n';
  const { buffer } = build(md);
  const headings = extractDocxParagraphs(buffer).filter((p) => p === p.toUpperCase() && p.trim()).slice(1);
  assert.deepEqual(headings, ['EDUCATION', 'SKILLS', 'PROFESSIONAL SUMMARY', 'EXTRACURRICULAR']);
});

test('model: an entry folds its title and dates onto one line with a right tab', () => {
  const { buffer } = build(MD);
  const paragraphs = extractDocxParagraphs(buffer);
  assert.ok(paragraphs.includes('Software Engineer | Acme Corp, Toronto, ON\t(Jan 2026 – Present)'), paragraphs.join('\n'));
  assert.ok(paragraphs.includes('Tracker | Job tracker (personal)\t(Mar – Apr 2025)'));
  assert.match(documentXml(buffer), new RegExp(`<w:tab w:val="right" w:pos="${LAYOUT.textWidth}"/>`));
});

test('model: a bold or italic date line stays a date and is not bold', () => {
  for (const dates of ['**Jan 2026 – Present**', '__Jan 2026 – Present__', '*Jan 2026 – Present*']) {
    const md = `# Jane\n\n## Experience\n\n### Acme — Toronto\n\n**Software Engineer**\n${dates}\n\n- x\n`;
    const built = build(md);
    const paragraphs = extractDocxParagraphs(built.buffer);
    assert.ok(paragraphs.includes('Software Engineer | Acme, Toronto\t(Jan 2026 – Present)'), `${dates}\n${paragraphs.join('\n')}`);
    const entry = documentXml(built.buffer).split('Software Engineer')[1].split('</w:p>')[0];
    const afterTab = entry.split('<w:tab/>')[1] ?? '';
    assert.equal(afterTab.includes('<w:b/>'), false, dates);
    assert.match(afterTab, /<w:i\/>/);
    assert.match(afterTab, /Jan 2026 – Present/);
    assert.equal(compareContent(md, built.buffer, built.model).ok, true);
  }
  const onlyDate = extractDocxParagraphs(build('# Jane\n\n## Experience\n\n### Acme — Toronto\n\n**Jan 2026 – Present**\n\n- x\n').buffer);
  assert.ok(onlyDate.includes('Acme | Toronto\t(Jan 2026 – Present)'), onlyDate.join('\n'));
  const summer = extractDocxParagraphs(build('# Jane\n\n## Experience\n\n### Acme — Toronto\n\n**Intern**\nSummer 2024\n\n- x\n').buffer);
  assert.ok(summer.includes('Intern | Acme, Toronto\t(Summer 2024)'), summer.join('\n'));
  const expected = extractDocxParagraphs(build('# Jane\n\n## Experience\n\n### Acme — Toronto\n\n**Intern**\nExpected May 2027\n\n- x\n').buffer);
  assert.ok(expected.includes('Intern | Acme, Toronto\t(Expected May 2027)'), expected.join('\n'));
});

test('pandoc: spans, heading attributes, triple dashes, and double dashes follow cv-markdown', () => {
  const md = [
    '# CV -- Jane Smith',
    '',
    '## **[Professional Experience]{.smallcaps}** {#experience .unnumbered}',
    '',
    '### **Acme Health, Inc.** --- New York, NY (Remote)',
    '',
    '**Senior Director, Platform Engineering**\\',
    '**09/2021 -- Present**',
    '',
    '- Shipped [the parser]{.smallcaps}',
    '',
    '## Skills',
    '',
    '- **Go:** yes',
    '',
  ].join('\n');
  const built = build(md);
  assert.equal(built.model.name, 'Jane Smith');
  assert.deepEqual(built.model.sections.map((s) => s.title), ['Professional Experience', 'Skills']);
  const paragraphs = extractDocxParagraphs(built.buffer);
  assert.ok(paragraphs.includes('PROFESSIONAL EXPERIENCE'), paragraphs.join('\n'));
  assert.equal(paragraphs.some((p) => /smallcaps|unnumbered|\{#/.test(p)), false);
  assert.ok(
    paragraphs.includes('Senior Director, Platform Engineering | Acme Health, Inc., New York, NY (Remote)\t(09/2021 – Present)'),
    paragraphs.join('\n'),
  );
  assert.ok(paragraphs.includes('Shipped the parser'));
  const compared = compareContent(md, built.buffer, built.model);
  assert.deepEqual(compared, { ok: true, missing: [], extra: [] });
});

test('model: a short sentence that mentions a year stays a sentence', () => {
  const md = '# Jane\n\n## Experience\n\n### Acme — Toronto\n\nLed team of 5 in 2023\n\n- Shipped it\n';
  const paragraphs = extractDocxParagraphs(build(md).buffer);
  assert.ok(paragraphs.includes('Acme | Toronto'), paragraphs.join('\n'));
  assert.equal(paragraphs.some((p) => p.includes('Led team of 5 in 2023)')), false);
  assert.ok(paragraphs.includes('Led team of 5 in 2023'));
});

test('model: entries without a title, without dates, with parenthesized dates, and with two separators', () => {
  const bare = extractDocxParagraphs(build('# Jane\n\n## Experience\n\n### Acme — Toronto\n\n- x\n').buffer);
  assert.ok(bare.includes('Acme | Toronto'));
  const noDates = extractDocxParagraphs(build('# Jane\n\n## Experience\n\n### Acme — Toronto\n\n**Software Engineer**\n\n- x\n').buffer);
  assert.ok(noDates.includes('Software Engineer | Acme, Toronto'));
  assert.equal(noDates.some((p) => p.includes('\t')), false);
  const wrapped = extractDocxParagraphs(build('# Jane\n\n## Experience\n\n### Acme — Toronto\n\n**Software Engineer**\n(Jan 2026 – Present)\n\n- x\n').buffer);
  assert.ok(wrapped.includes('Software Engineer | Acme, Toronto\t(Jan 2026 – Present)'), wrapped.join('\n'));
  assert.equal(wrapped.some((p) => p.includes('((Jan')), false);
  const split = extractDocxParagraphs(build('# Jane\n\n## Experience\n\n### A — B — C\n\n**Title**\nJan 2020 – Present\n\n- x\n').buffer);
  assert.ok(split.includes('Title | A, B — C\t(Jan 2020 – Present)'), split.join('\n'));
});

test('model: name prefixes, contact shapes, and a later top-level heading', () => {
  for (const heading of ['# Jane Smith', '# CV -- Jane Smith', '# CV — Jane Smith', '# CV: Jane Smith']) {
    const built = build(`${heading}\n\n## A\n\n- x\n`);
    assert.equal(built.model.name, 'Jane Smith', heading);
    assert.equal(compareContent(`${heading}\n\n## A\n\n- x\n`, built.buffer, built.model).ok, true);
  }
  assert.throws(() => parseResume('# CV --\n\n## A\n\n- x\n'), /empty/);
  assert.throws(() => parseResume('Jane\n====\n\n## A\n\n- x\n'), /No "# Name" heading/);

  const contact = build('# Jane\n\n**Email**: jane@example.com\n**Phone:** +1 555 0100\n**GitHub:** github.com/janesmith\n\n## A\n\n- x\n');
  assert.deepEqual(contact.model.contact.map((c) => c.label), ['Email', 'Phone', 'GitHub']);
  const rels = readZip(contact.buffer).get('word/_rels/document.xml.rels').toString();
  assert.match(rels, /Target="mailto:jane@example.com"/);
  assert.match(rels, /Target="https:\/\/github.com\/janesmith"/);
  assert.equal(/555/.test(rels), false);

  const unlabeled = build('# Jane\n\n**Email:**\n\n## A\n\n- x\n');
  assert.deepEqual(unlabeled.model.contact, []);
  assert.ok(extractDocxParagraphs(unlabeled.buffer).includes('Email:'));

  assert.throws(
    () => parseResume('# Jane\n\n## A\n\n- x\n\n# Later\n\n- y\n'),
    /Unexpected "#" heading "Later"/,
  );
  assert.throws(
    () => parseResume('# Jane\n\n# **Later**\n\n## A\n\n- x\n'),
    /Unexpected "#" heading "Later"/,
  );
});

test('underscore bold, parenthesized links, and capital sharp S survive in the document', () => {
  const bold = build('# Jane\n\n## Work\n\n- Built __fast__ tools\n');
  assert.match(documentXml(bold.buffer), /<w:b\/>[\s\S]*?<w:t[^>]*>fast<\/w:t>/);
  assert.equal(extractDocxParagraphs(bold.buffer).some((p) => p.includes('__')), false);
  assert.equal(compareContent('# Jane\n\n## Work\n\n- Built __fast__ tools\n', bold.buffer, bold.model).ok, true);

  const wiki = '# Jane\n\n## Links\n\n- [Wiki](https://en.wikipedia.org/wiki/Foo_(bar))\n';
  const linked = build(wiki);
  assert.ok(extractDocxParagraphs(linked.buffer).includes('Wiki'));
  assert.match(readZip(linked.buffer).get('word/_rels/document.xml.rels').toString(), /Target="https:\/\/en\.wikipedia\.org\/wiki\/Foo_\(bar\)"/);
  assert.equal(compareContent(wiki, linked.buffer, linked.model).ok, true);

  const german = '# Jane\n\n## Weiterbildung Straße\n\n- x\n';
  const built = build(german);
  assert.ok(extractDocxParagraphs(built.buffer).includes('WEITERBILDUNG STRAẞE'));
  assert.equal(compareContent(german, built.buffer, built.model).ok, true);
});

test('layout: the document applies the reference values', () => {
  const xml = documentXml(build(MD).buffer);
  assert.match(xml, new RegExp(`<w:pgSz w:w="${LAYOUT.pageWidth}" w:h="${LAYOUT.pageHeight}"/>`));
  assert.match(xml, new RegExp(
    `<w:pgMar w:top="${LAYOUT.marginTop}" w:right="${LAYOUT.marginRight}" w:bottom="${LAYOUT.marginBottom}" w:left="${LAYOUT.marginLeft}"`,
  ));
  assert.match(xml, new RegExp(`<w:sz w:val="${LAYOUT.nameSize}"/>`), 'name size');
  assert.match(xml, new RegExp(`<w:bottom w:val="single" w:sz="${LAYOUT.ruleSize}" w:space="1" w:color="000000"/>`), 'rules');
  assert.match(xml, new RegExp(`<w:sz w:val="${LAYOUT.skillsSize}"/>`), 'skills size');
  assert.match(xml, new RegExp(`w:footer="${LAYOUT.footerDistance}"`), 'footer distance');
  assert.match(xml, new RegExp(`w:before="${LAYOUT.sectionBefore}"`), 'section spacing');
  assert.match(xml, new RegExp(`w:before="${LAYOUT.entryBefore}"`), 'entry spacing');
  assert.match(xml, /<w:t xml:space="preserve">PROFESSIONAL SUMMARY<\/w:t>/, 'uppercase headings');
  assert.ok(xml.indexOf('PROFESSIONAL SUMMARY') < xml.indexOf('WORK EXPERIENCE'));
  const summary = xml.split('>PROFESSIONAL SUMMARY<')[1].split('>WORK EXPERIENCE<')[0];
  assert.match(summary, new RegExp(`<w:ind w:left="${LAYOUT.bodyIndent}"/>`), 'body indent');
  assert.match(summary, new RegExp(`w:ascii="${LAYOUT.font}"`), 'body font');
  assert.match(summary, new RegExp(`<w:sz w:val="${LAYOUT.bodySize}"/>`), 'body size');
  const experience = xml.split('>WORK EXPERIENCE<')[1].split('>PROJECTS<')[0];
  assert.match(experience, /<w:numPr><w:ilvl w:val="0"\/><w:numId w:val="1"\/><\/w:numPr>/, 'experience bullets');
  assert.match(experience, new RegExp(`w:ascii="${LAYOUT.font}"`), 'experience font');
  assert.match(experience, new RegExp(`<w:sz w:val="${LAYOUT.bodySize}"/>`), 'experience size');
  const afterSkills = xml.split('>SKILLS<')[1] ?? '';
  assert.ok(afterSkills.includes('Languages:') && !afterSkills.includes('<w:numPr>'), 'skills lines carry no bullet glyph');
});

test('layout: template parts agree with LAYOUT', () => {
  const styles = readTemplatePart('word/styles.xml').toString();
  assert.match(styles, new RegExp(`w:ascii="${LAYOUT.font}"`));
  assert.match(styles, new RegExp(`<w:sz w:val="${LAYOUT.bodySize}"/>`));
  assert.match(styles, new RegExp(`w:line="${LAYOUT.lineSpacing}"`));
  const numbering = readTemplatePart('word/numbering.xml').toString();
  assert.match(numbering, new RegExp(`<w:lvlText w:val="${LAYOUT.bulletGlyph}"/>`));
  assert.match(numbering, new RegExp(`w:ascii="${LAYOUT.bulletFont}"`));
  assert.match(numbering, new RegExp(`<w:ind w:left="${LAYOUT.bulletLeft}" w:hanging="${LAYOUT.bulletHanging}"/>`));
  assert.equal(LAYOUT.textWidth, LAYOUT.pageWidth - LAYOUT.marginLeft - LAYOUT.marginRight);
  for (const p of TEMPLATE_PARTS) assert.ok(existsSync(join(TEMPLATE_DIR, p.path)), p.path);
});

// TODO: open the generated .docx in Word as part of an end-to-end test.
// These checks read the package XML; they do not prove Word opens the file.
test('package: every part is declared, related and well formed', () => {
  const parts = readZip(build(MD).buffer);
  const types = parts.get('[Content_Types].xml').toString();
  const rels = parts.get('word/_rels/document.xml.rels').toString();
  for (const p of TEMPLATE_PARTS) {
    assert.ok(parts.has(p.path), `${p.path} is packaged`);
    assert.ok(types.includes(`PartName="/${p.path}"`), `${p.path} has a content type`);
    assert.ok(rels.includes(`Id="${p.id}"`), `${p.path} is related`);
  }
  assert.ok(parts.has('word/document.xml') && types.includes('/word/document.xml'));
  const root = parts.get('_rels/.rels').toString();
  assert.match(root, /Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/officeDocument" Target="word\/document\.xml"/);
});

test('links: rStyle comes before rFonts in rPr', () => {
  const xml = documentXml(build(MD).buffer);
  assert.match(xml, /<w:rPr><w:rStyle w:val="Hyperlink"\/><w:rFonts /);
});

test('buildDocx returns only buffer and model', () => {
  assert.deepEqual(Object.keys(build(MD)), ['buffer', 'model']);
});

test('links: a repeated target is stored once, marked external, and escaped', () => {
  const md = `${MD}\n## Extra\n\n- [one](https://example.com/ts)\n- [two](https://example.com/ts)\n- [amp](https://example.com/?a=1&b=2)\n- [q](https://example.com/a"b)\n- [bad](JAVASCRIPT:alert(1))\n- [data](data:text/html,hi)\n`;
  const rels = readZip(build(md).buffer).get('word/_rels/document.xml.rels').toString();
  assert.equal(rels.match(/Target="https:\/\/example\.com\/ts"/g).length, 1);
  assert.match(rels, /Target="https:\/\/example\.com\/ts" TargetMode="External"/);
  assert.match(rels, /Target="https:\/\/example\.com\/\?a=1&amp;b=2" TargetMode="External"/);
  assert.match(rels, /Target="https:\/\/example\.com\/a&quot;b" TargetMode="External"/);
  assert.equal(/javascript:/i.test(rels), false);
  assert.equal(/data:/i.test(rels), false);
});

test('skills: a heading that ends with Skills drops the bullet glyph, including a nested line', () => {
  const xml = documentXml(build('# Jane\n\n## Soft Skills\n\n- **Languages:** Go\n  - extra\n').buffer);
  const after = xml.split('>SOFT SKILLS<')[1] ?? '';
  assert.equal(after.includes('<w:numPr>'), false);
  assert.match(after, new RegExp(`<w:sz w:val="${LAYOUT.skillsSize}"/>`));
});

test('skills: a heading that merely contains the word keeps normal bullets and body size', () => {
  const xml = documentXml(build('# Jane\n\n## Communication Skills Training\n\n- Led a workshop\n').buffer);
  const after = xml.split('>COMMUNICATION SKILLS TRAINING<')[1] ?? '';
  assert.match(after, /<w:numId w:val="1"\/>/);
  assert.equal(after.includes(`<w:sz w:val="${LAYOUT.skillsSize}"/>`), false);
  assert.match(after, new RegExp(`<w:sz w:val="${LAYOUT.bodySize}"/>`));
});

test('links: email and domains become hyperlinks; unsafe schemes do not', () => {
  const md = `${MD}\n## Extra\n\n- [bad](javascript:alert(1))\n`;
  const { buffer } = build(md);
  const rels = readZip(buffer).get('word/_rels/document.xml.rels').toString();
  assert.match(rels, /Target="mailto:jane@example.com"/);
  assert.match(rels, /Target="https:\/\/linkedin.com\/in\/janesmith"/);
  assert.match(rels, /Target="https:\/\/example.com\/ts"/);
  assert.ok(!/javascript:/i.test(rels), 'javascript: link must not become a relationship');
  assert.ok(extractDocxParagraphs(buffer).some((p) => p.includes('bad')), 'link text is kept');
});

test('escaping: markup characters in the text stay text', () => {
  const xml = documentXml(build(MD).buffer);
  assert.ok(xml.includes('Builds things &amp; ships a &lt; b software.'));
  assert.ok(!xml.includes(' a < b '));
});

test('content check: passes on the real output and catches gained or lost words', () => {
  const built = build(MD);
  assert.deepEqual(compareContent(MD, built.buffer, built.model), { ok: true, missing: [], extra: [] });

  const lost = compareContent(`${MD}\n- An extra bullet nobody rendered\n`, built.buffer, built.model);
  assert.equal(lost.ok, false);
  assert.ok(lost.missing.includes('nobody'));

  const gained = compareContent(MD.replace('Cut cost by 10%', 'Cut cost'), built.buffer, built.model);
  assert.equal(gained.ok, false);
  assert.ok(gained.extra.includes('by') && gained.extra.includes('10'));
});

test('input: a document with no name heading or with stray leading content is refused', () => {
  assert.throws(() => parseResume('## Only a section\n\n- x\n'), /No "# Name" heading/);
  assert.throws(() => parseResume('stray\n\n# Name\n\n## S\n\n- x\n'), /before the "# Name" heading/);
  assert.throws(() => parseResume('# Name\n\nstuff\n\n### Entry\n'), /Content found before the first "## Section"/);
});

test('examples/cv-example.md renders and verifies', () => {
  const md = readFileSync(join(ROOT, 'examples', 'cv-example.md'), 'utf8');
  const built = build(md);
  assert.deepEqual(compareContent(md, built.buffer, built.model), { ok: true, missing: [], extra: [] });
  const order = (md.match(/^## .+$/gm) ?? []).map((h) => h.slice(3).trim().toUpperCase());
  const rendered = extractDocxParagraphs(built.buffer).filter((p) => order.includes(p));
  assert.deepEqual(rendered, order, 'section order must equal examples/cv-example.md');
});

test('real cv.md renders and verifies', { skip: !existsSync(join(ROOT, 'cv.md')) }, () => {
  const md = readFileSync(join(ROOT, 'cv.md'), 'utf8');
  const built = build(md);
  assert.deepEqual(compareContent(md, built.buffer, built.model), { ok: true, missing: [], extra: [] });
  const order = (md.match(/^## .+$/gm) ?? []).map((h) => h.slice(3).trim().toUpperCase());
  const rendered = extractDocxParagraphs(built.buffer).filter((p) => order.includes(p));
  assert.deepEqual(rendered, order, 'section order must equal cv.md');
});

function run(args) {
  return spawnSync(process.execPath, [join(ROOT, 'generate-docx.mjs'), ...args], { encoding: 'utf8' });
}

test('cli: writes a verified .docx and reports it', () => {
  withTempDir((dir) => {
    const input = join(dir, 'tailored.md');
    const output = join(dir, 'out', 'cv.docx');
    writeFileSync(input, MD);
    const r = run([input, output, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.sections, 4);
    assert.ok(existsSync(output));
    assert.deepEqual(readZip(readFileSync(output)).get('word/document.xml') !== undefined, true);
  });
});

test('cli: refuses unsupported markdown and leaves no file', () => {
  withTempDir((dir) => {
    const input = join(dir, 'bad.md');
    const output = join(dir, 'cv.docx');
    writeFileSync(input, '# N\n\n## S\n\n| a | b |\n');
    const r = run([input, output]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unsupported markdown \(table\)/);
    assert.ok(!existsSync(output));
  });
});

test('cli: refuses a wrong extension, a missing input, an unknown template and a stray flag', () => {
  withTempDir((dir) => {
    const input = join(dir, 'ok.md');
    writeFileSync(input, MD);
    assert.match(run([input, join(dir, 'cv.pdf')]).stderr, /must end in \.docx/);
    assert.match(run([join(dir, 'nope.md'), join(dir, 'cv.docx')]).stderr, /Input not found/);
    assert.match(run([input, join(dir, 'cv.docx'), '--template=missing']).stderr, /Template not found/);
    assert.match(run([input, join(dir, 'cv.docx'), '--template=../x']).stderr, /Invalid template name/);
    const stray = run([input, join(dir, 'cv.docx'), '--bogus']);
    assert.notEqual(stray.status, 0);
  });
});

test('cli: refuses to write outside the project, data root and temp directory', () => {
  withTempDir((dir) => {
    const input = join(dir, 'ok.md');
    writeFileSync(input, MD);
    const outside = mkdtempOutsideAllowed();
    try {
      const output = join(outside, 'cv.docx');
      const r = run([input, output]);
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /outside the project directory/);
      assert.ok(!existsSync(output));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('cli: plain output, a spaced template flag, help, an uppercase extension, and overwrite', () => {
  withTempDir((dir) => {
    const input = join(dir, 'ok.md');
    const output = join(dir, 'CV.DOCX');
    writeFileSync(input, MD);
    writeFileSync(output, 'OLD');
    const plain = run([input, output, '--template', 'garamond']);
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, new RegExp(`Wrote ${output.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(\\d+ bytes, 4 sections\\)`));
    assert.equal(plain.stdout.trim().startsWith('{'), false);
    assert.ok(extractDocxParagraphs(readFileSync(output)).includes('Jane Smith'));

    const again = run([input, output]);
    assert.equal(again.status, 0, again.stderr);
    assert.ok(extractDocxParagraphs(readFileSync(output)).includes('Jane Smith'));

    const help = run(['--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage:/);
    assert.match(help.stdout, /--template=NAME/);
  });
});

test('B2: a read-only existing good.docx survives a failed write', (t) => {
  withTempDir((dir) => {
    const input = join(dir, 'ok.md');
    const output = join(dir, 'good.docx');
    writeFileSync(input, MD);
    writeFileSync(output, 'OLD-BYTES');
    chmodSync(output, 0o444);
    chmodSync(dir, 0o555);
    try {
      const result = generateDocx({ input, output });
      if (result.ok) {
        t.skip('directory mode does not block writes on this platform');
        return;
      }
      assert.match(result.error, /Could not write/);
      chmodSync(dir, 0o700);
      chmodSync(output, 0o644);
      assert.equal(readFileSync(output, 'utf8'), 'OLD-BYTES');
    } finally {
      try { chmodSync(dir, 0o700); } catch { /* already restored */ }
      try { chmodSync(output, 0o644); } catch { /* already restored */ }
    }
  });
});

test('cli: a planted temp-looking file is left alone', () => {
  withTempDir((dir) => {
    const input = join(dir, 'ok.md');
    const output = join(dir, 'cv.docx');
    writeFileSync(input, MD);
    const planted = join(dir, `.cv.docx.${process.pid}.tmp`);
    writeFileSync(planted, 'PLANTED');
    const result = generateDocx({ input, output });
    assert.equal(result.ok, true, result.error);
    assert.equal(readFileSync(planted, 'utf8'), 'PLANTED');
  });
});

test('cli: overwriting keeps the existing file mode', (t) => {
  withTempDir((dir) => {
    const input = join(dir, 'ok.md');
    const output = join(dir, 'cv.docx');
    writeFileSync(input, MD);
    writeFileSync(output, 'OLD', { mode: 0o600 });
    const before = statSync(output).mode & 0o777;
    if (before !== 0o600) {
      t.skip(`file mode is not honoured (got ${before.toString(8)})`);
      return;
    }
    const result = generateDocx({ input, output });
    assert.equal(result.ok, true, result.error);
    assert.equal(statSync(output).mode & 0o777, 0o600);
  });
});

test('B1: a dangling-symlink chain does not write outside', (t) => {
  withTempDir((scratch) => {
    const input = join(scratch, 'ok.md');
    writeFileSync(input, MD);
    const outside = mkdtempOutsideAllowed();
    try {
      const linkdir = join(scratch, 'linkdir');
      try {
        symlinkSync(outside, linkdir, 'junction');
      } catch (error) {
        if (error.code === 'EPERM' || error.code === 'EACCES') {
          t.skip(`symlink unsupported: ${error.code}`);
          return;
        }
        throw error;
      }
      const output = join(scratch, 'cv.docx');
      try {
        symlinkSync(join('linkdir', 'pwned.docx'), output);
      } catch (error) {
        if (error.code === 'EPERM' || error.code === 'EACCES') {
          t.skip(`symlink unsupported: ${error.code}`);
          return;
        }
        throw error;
      }
      const r = run([input, output]);
      assert.ok(!existsSync(join(outside, 'pwned.docx')), 'must not follow the dangling chain');
      assert.equal(r.status, 0, r.stderr);
      assert.equal(lstatSync(output).isSymbolicLink(), false);
      assert.ok(extractDocxParagraphs(readFileSync(output)).includes('Jane Smith'));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('cli: a symlinked parent is refused', (t) => {
  withTempDir((inputDir) => {
    const input = join(inputDir, 'ok.md');
    writeFileSync(input, MD);
    const outside = mkdtempOutsideAllowed();
    const scratch = mkdtempSync(join(tmpdir(), 'docx-cli-link-'));
    try {
      const linkedParent = join(scratch, 'parent');
      try {
        symlinkSync(outside, linkedParent, 'junction');
      } catch (error) {
        if (error.code === 'EPERM' || error.code === 'EACCES') {
          t.skip(`symlink unsupported: ${error.code}`);
          return;
        }
        throw error;
      }
      const viaParent = run([input, join(linkedParent, 'cv.docx')]);
      assert.equal(viaParent.status, 1, viaParent.stderr);
      assert.match(viaParent.stderr, /outside the project directory/);
      assert.ok(!existsSync(join(outside, 'cv.docx')));
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

test('cli: a symlinked file is refused or replaced in place, never followed', (t) => {
  withTempDir((inputDir) => {
    const input = join(inputDir, 'ok.md');
    writeFileSync(input, MD);
    const outside = mkdtempOutsideAllowed();
    const scratch = mkdtempSync(join(tmpdir(), 'docx-cli-file-'));
    try {
      const linkedFile = join(scratch, 'cv.docx');
      try {
        symlinkSync(join(outside, 'escaped.docx'), linkedFile);
      } catch (error) {
        if (error.code === 'EPERM' || error.code === 'EACCES') {
          t.skip(`symlink unsupported: ${error.code}`);
          return;
        }
        throw error;
      }
      const viaFile = run([input, linkedFile]);
      assert.ok(!existsSync(join(outside, 'escaped.docx')));
      if (viaFile.status === 0) {
        assert.equal(lstatSync(linkedFile).isSymbolicLink(), false);
      } else {
        assert.match(viaFile.stderr, /outside the project directory/);
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

test('cli: CAREER_OPS_ROOT allows the data root', () => {
  withTempDir((inputDir) => {
    const input = join(inputDir, 'ok.md');
    writeFileSync(input, MD);
    const dataRoot = mkdtempOutsideAllowed('career-ops-docx-data-');
    try {
      const allowed = join(dataRoot, 'cv.docx');
      const viaRoot = spawnSync(process.execPath, [join(ROOT, 'generate-docx.mjs'), input, allowed], {
        encoding: 'utf8',
        env: { ...process.env, CAREER_OPS_ROOT: dataRoot },
      });
      assert.equal(viaRoot.status, 0, viaRoot.stderr);
      assert.ok(existsSync(allowed));
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});

test('layout: numbering.xml names a bullet glyph font', () => {
  const numbering = readTemplatePart('word/numbering.xml').toString();
  assert.match(numbering, new RegExp(`<w:rFonts w:ascii="${LAYOUT.bulletFont}" w:hAnsi="${LAYOUT.bulletFont}" w:cs="${LAYOUT.bulletFont}"/>`));
  assert.notEqual(LAYOUT.bulletFont, LAYOUT.font);
});

test('page length: wrapping bullets warn above one page', () => {
  const long = 'Word '.repeat(40).trim();
  const items = Array.from({ length: 48 }, (_, i) => `- Uniqueitem${i} ${long}`).join('\n');
  const md = `# Jane\n\n## Work\n\n${items}\n`;
  withTempDir((dir) => {
    const input = join(dir, 'ok.md');
    const output = join(dir, 'cv.docx');
    writeFileSync(input, md);
    const result = generateDocx({ input, output });
    assert.equal(result.ok, true, result.error);
    assert.match(result.warning, /longer than one page/);
    assert.equal(existsSync(output), true);
  });
  assert.equal(pageLengthWarning(['short'], 1), null);
});

test('cli: mkdtempOutsideAllowed dirs are cleaned up in finally', () => {
  let dir;
  try {
    dir = mkdtempOutsideAllowed();
    assert.equal(existsSync(dir), true);
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(existsSync(dir), false);
});

test('cli: mixed-case output roots are allowed on darwin/win32', (t) => {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    t.skip('case-insensitive filesystems only');
    return;
  }
  const src = readFileSync(join(ROOT, 'generate-docx.mjs'), 'utf8');
  assert.equal(/generate-pdf\.mjs/.test(src), false, 'output-root policy must stay docx-local');
  const leaf = ROOT.split(sep).pop();
  const flipped = leaf.replace(/[A-Za-z]/, (ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()));
  const mixedRoot = join(ROOT.slice(0, ROOT.length - leaf.length), flipped);
  if (mixedRoot === ROOT || !existsSync(join(mixedRoot, 'generate-docx.mjs'))) {
    t.skip('could not form a mixed-case spelling of the project root');
    return;
  }
  const dir = mkdtempSync(join(mixedRoot, 'docx-case-'));
  try {
    const input = join(dir, 'ok.md');
    const output = join(dir, 'cv.docx');
    writeFileSync(input, MD);
    const r = spawnSync(process.execPath, [join(mixedRoot, 'generate-docx.mjs'), input, output], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(output), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: a different-case sibling of the data root is refused', (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'docx-case-sibling-'));
  const upper = join(parent, 'CaseRoot');
  const lower = join(parent, 'caseroot');
  mkdirSync(upper);
  try {
    mkdirSync(lower);
  } catch {
    t.skip('filesystem cannot hold two case-distinct siblings');
    rmSync(parent, { recursive: true, force: true });
    return;
  }
  let upperReal;
  let lowerReal;
  try {
    upperReal = realpathSync.native(upper);
    lowerReal = realpathSync.native(lower);
  } catch (error) {
    t.skip(`native realpath failed: ${error.message}`);
    rmSync(parent, { recursive: true, force: true });
    return;
  }
  if (upperReal === lowerReal) {
    t.skip('volume is case-insensitive');
    rmSync(parent, { recursive: true, force: true });
    return;
  }
  try {
    const input = join(parent, 'ok.md');
    writeFileSync(input, MD);
    const output = join(lower, 'escape.docx');
    const r = spawnSync(process.execPath, [join(ROOT, 'generate-docx.mjs'), input, output], {
      encoding: 'utf8',
      env: { ...process.env, CAREER_OPS_ROOT: upper },
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /outside the project directory/);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
