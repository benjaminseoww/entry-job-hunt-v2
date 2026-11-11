// tests/verify-cv-facts-docx.test.mjs — the fact gate must read a Word
// resume, not its zip bytes.
//
// `.docx` is a zip of XML. Reading it as UTF-8 feeds the gate PK headers and
// deflated runs, so a fabricated metric inside word/document.xml is invisible
// and a truthful CV can look invented. The CLI extracts the document text
// first (body, headers, notes), then verifies it as plain text.
//
// Run:  node --test tests/verify-cv-facts-docx.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDocx } from '../generate-docx.mjs';
import { extractDocxText, unescapeXml } from '../lib/docx-text.mjs';
import { readZip, readZipEntries, writeZip, MAX_ZIP_ENTRY_BYTES } from '../lib/docx-zip.mjs';
import { readGeneratedText, verifyFacts } from '../verify-cv-facts.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WML = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const OD_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

const resume = (bullet) => `# CV -- Jane Smith

**Email:** jane@example.com

## Work Experience

### Acme Corp -- Toronto, ON

**Software Engineer**
Jan 2026 – Present

- ${bullet}
`;

function q(prefix, name) {
  return prefix ? `${prefix}:${name}` : name;
}

function wmlDocument(prefix, inner) {
  const xmlns = prefix
    ? `xmlns:${prefix}="${WML}"`
    : `xmlns="${WML}"`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><${q(prefix, 'document')} ${xmlns}><${q(prefix, 'body')}>${inner}</${q(prefix, 'body')}></${q(prefix, 'document')}>`;
}

function paragraph(prefix, inner) {
  return `<${q(prefix, 'p')}><${q(prefix, 'r')}>${inner}</${q(prefix, 'r')}></${q(prefix, 'p')}>`;
}

function t(prefix, text) {
  return `<${q(prefix, 't')}>${text}</${q(prefix, 't')}>`;
}

function relsXml(links) {
  const rows = links.map((link, i) => (
    `<Relationship Id="rId${i + 1}" Type="${OD_REL}/${link.type}" Target="${link.target}"/>`
  )).join('');
  return `<?xml version="1.0"?><Relationships xmlns="${PKG_REL}">${rows}</Relationships>`;
}

function packDocx(parts) {
  return writeZip(Object.entries(parts).map(([name, data]) => ({ name, data })));
}

function writePacked(dir, filename, parts) {
  const path = join(dir, filename);
  writeFileSync(path, packDocx(parts));
  return path;
}

function writeDocx(dir, name, bullet) {
  const md = join(dir, `${name}.md`);
  const docx = join(dir, `${name}.docx`);
  writeFileSync(md, resume(bullet));
  const result = generateDocx({ input: md, output: docx });
  assert.equal(result.ok, true, result.error ?? 'generateDocx failed');
  return docx;
}

function runCli(file, { dataRoot, extra = [] } = {}) {
  return spawnSync(process.execPath, [join(ROOT, 'verify-cv-facts.mjs'), file, ...extra], {
    cwd: dataRoot,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, CAREER_OPS_ROOT: dataRoot, CAREER_OPS_DATA_DIR: '' },
  });
}

function withDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function setDeclaredUncompSize(zip, name, size) {
  const buf = Buffer.from(zip);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.ok(eocd >= 0, 'eocd');
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let n = 0; n < count; n++) {
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const entryName = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (entryName === name) {
      buf.writeUInt32LE(size >>> 0, p + 24);
      return buf;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`zip entry not found: ${name}`);
}

test('readGeneratedText returns the resume words, not zip bytes', () => {
  withDir('career-ops-facts-docx-text-', (dir) => {
    const docx = writeDocx(dir, 'cv', 'Led a team of 4 engineers.');
    const text = readGeneratedText(docx);
    assert.match(text, /Led a team of 4 engineers/);
    assert.doesNotMatch(text, /^PK/);
    assert.equal(text, extractDocxText(readFileSync(docx)));
  });
});

test('a claim copied from cv.md into the .docx is not reported as fabricated', () => {
  withDir('career-ops-facts-docx-pass-', (dir) => {
    writeFileSync(join(dir, 'cv.md'), resume('Led a team of 4 engineers.'));
    const docx = writeDocx(dir, 'out', 'Led a team of 4 engineers.');
    const result = verifyFacts(readGeneratedText(docx), {
      sourcePaths: [join(dir, 'cv.md')],
      configPath: join(dir, 'no-such-cv-facts.json'),
      format: 'text',
    });
    assert.equal(result.verdict, 'pass');
    assert.deepEqual(result.invented, []);
  });
});

test('an inflated metric in the .docx is blocked', () => {
  withDir('career-ops-facts-docx-block-', (dir) => {
    writeFileSync(join(dir, 'cv.md'), resume('Led a team of 4 engineers.'));
    const docx = writeDocx(dir, 'out', 'Led a team of 40 engineers.');
    const result = verifyFacts(readGeneratedText(docx), {
      sourcePaths: [join(dir, 'cv.md')],
      configPath: join(dir, 'no-such-cv-facts.json'),
      format: 'text',
    });
    assert.equal(result.verdict, 'block');
    assert.ok(result.invented.some((claim) => /40 engineers/.test(claim)), result.invented.join(', '));
  });
});

test('the CLI extracts a .docx and still reads a .md as text', () => {
  withDir('career-ops-facts-docx-cli-', (dir) => {
    writeFileSync(join(dir, 'cv.md'), resume('Led a team of 4 engineers.'));
    const honest = writeDocx(dir, 'honest', 'Led a team of 4 engineers.');
    const inflated = writeDocx(dir, 'inflated', 'Led a team of 40 engineers.');
    const md = join(dir, 'plain.md');
    writeFileSync(md, resume('Led a team of 4 engineers.'));

    const passDocx = runCli(honest, { dataRoot: dir });
    assert.equal(passDocx.status, 0, passDocx.stderr);
    assert.match(`${passDocx.stdout}${passDocx.stderr}`, /fact check passed/i);

    const blockDocx = runCli(inflated, { dataRoot: dir, extra: ['--json'] });
    assert.equal(blockDocx.status, 1, blockDocx.stderr);
    const parsed = JSON.parse(blockDocx.stdout);
    assert.equal(parsed.verdict, 'block');
    assert.ok(parsed.invented.some((claim) => /40 engineers/.test(claim)), parsed.invented.join(', '));

    const passMd = runCli(md, { dataRoot: dir });
    assert.equal(passMd.status, 0, passMd.stderr);
  });
});

test('a file that is not a Word document fails loudly', () => {
  withDir('career-ops-facts-docx-bad-', (dir) => {
    writeFileSync(join(dir, 'cv.md'), resume('Led a team of 4 engineers.'));
    const fake = join(dir, 'fake.docx');
    writeFileSync(fake, 'this is not a zip');
    const r = runCli(fake, { dataRoot: dir });
    assert.equal(r.status, 1);
    assert.match(`${r.stdout}${r.stderr}`, /Corrupt \.docx:/);
  });
});

test('plain-text mode keeps angle-bracket claims and does not double-decode entities', () => {
  withDir('career-ops-facts-docx-textmode-', (dir) => {
    writeFileSync(join(dir, 'cv.md'), resume('Led a team of 4 engineers.'));
    const opts = {
      sourcePaths: [join(dir, 'cv.md')],
      configPath: join(dir, 'no-such-cv-facts.json'),
      format: 'text',
    };
    const angled = verifyFacts('Led <team of 40 engineers.>', opts);
    assert.equal(angled.verdict, 'block', 'angle-bracket claim must stay visible');
    assert.ok(angled.invented.some((claim) => /40 engineers/.test(claim)), angled.invented.join(', '));

    const entity = verifyFacts('Led a team of &#52;0 engineers.', opts);
    assert.equal(entity.invented.some((claim) => /40 engineers/.test(claim)), false, entity.invented.join(', '));
  });
});

test('default HTML markup mode still swallows the angle-bracket claim', () => {
  withDir('career-ops-facts-docx-htmlmode-', (dir) => {
    writeFileSync(join(dir, 'cv.md'), resume('Led a team of 4 engineers.'));
    const htmlMode = verifyFacts('Led <team of 40 engineers.>', {
      sourcePaths: [join(dir, 'cv.md')],
      configPath: join(dir, 'no-such-cv-facts.json'),
    });
    assert.equal(htmlMode.invented.some((claim) => /40 engineers/.test(claim)), false);
  });
});

test('a claim after a nested text-box paragraph is still gated', () => {
  withDir('career-ops-facts-docx-textbox-', (dir) => {
    writeFileSync(join(dir, 'cv.md'), resume('Led a team of 4 engineers.'));
    const inner = paragraph('w', t('w', 'IntroBox text'));
    const body = `<w:p><w:r><w:drawing><w:txbxContent>${inner}</w:txbxContent></w:drawing></w:r><w:r>${t('w', 'Led a team of 40 engineers.')}</w:r></w:p>`;
    const path = writePacked(dir, 'box.docx', { 'word/document.xml': wmlDocument('w', body) });
    const text = extractDocxText(readFileSync(path));
    assert.match(text, /IntroBox text/);
    assert.match(text, /Led a team of 40 engineers/);
    const result = verifyFacts(text, {
      sourcePaths: [join(dir, 'cv.md')],
      configPath: join(dir, 'no-such-cv-facts.json'),
      format: 'text',
    });
    assert.equal(result.verdict, 'block');
    assert.ok(result.invented.some((claim) => /40 engineers/.test(claim)));
  });
});

test('header, footnotes and an x: namespace prefix are readable', () => {
  withDir('career-ops-facts-docx-parts-', (dir) => {
    writeFileSync(join(dir, 'cv.md'), resume('Led a team of 4 engineers.'));
    const header = writePacked(dir, 'header.docx', {
      'word/document.xml': wmlDocument('w', paragraph('w', t('w', 'IntroBox text'))),
      'word/_rels/document.xml.rels': relsXml([{ type: 'header', target: 'header1.xml' }]),
      'word/header1.xml': `<w:hdr xmlns:w="${WML}">${paragraph('w', t('w', 'Led a team of 40 engineers.'))}</w:hdr>`,
    });
    const notes = writePacked(dir, 'notes.docx', {
      'word/document.xml': wmlDocument('w', paragraph('w', t('w', 'IntroBox text'))),
      'word/_rels/document.xml.rels': relsXml([{ type: 'footnotes', target: 'footnotes.xml' }]),
      'word/footnotes.xml': `<w:footnotes xmlns:w="${WML}">${paragraph('w', t('w', 'Led a team of 40 engineers.'))}</w:footnotes>`,
    });
    const footer = writePacked(dir, 'footer.docx', {
      'word/document.xml': wmlDocument('w', paragraph('w', t('w', 'IntroBox text'))),
      'word/_rels/document.xml.rels': relsXml([{ type: 'footer', target: 'footer1.xml' }]),
      'word/footer1.xml': `<w:ftr xmlns:w="${WML}">${paragraph('w', t('w', 'Led a team of 40 engineers.'))}</w:ftr>`,
    });
    const prefixed = writePacked(dir, 'xprefix.docx', {
      'word/document.xml': wmlDocument('x', paragraph('x', t('x', 'Led a team of 40 engineers.'))),
    });
    for (const file of [header, notes, footer, prefixed]) {
      const text = extractDocxText(readFileSync(file));
      assert.match(text, /40 engineers/, file);
      const result = verifyFacts(text, {
        sourcePaths: [join(dir, 'cv.md')],
        configPath: join(dir, 'no-such-cv-facts.json'),
        format: 'text',
      });
      assert.equal(result.verdict, 'block', file);
    }
  });
});

test('runs split mid-number still form 40 engineers', () => {
  withDir('career-ops-facts-docx-split-', (dir) => {
    writeFileSync(join(dir, 'cv.md'), resume('Led a team of 4 engineers.'));
    const inner = `<w:r>${t('w', 'Led a team of ')}</w:r><w:r>${t('w', '4')}</w:r><w:r>${t('w', '0 engineers.')}</w:r>`;
    const path = writePacked(dir, 'split.docx', {
      'word/document.xml': wmlDocument('w', `<w:p>${inner}</w:p>`),
    });
    const text = extractDocxText(readFileSync(path));
    assert.match(text, /40 engineers/);
    const result = verifyFacts(text, {
      sourcePaths: [join(dir, 'cv.md')],
      configPath: join(dir, 'no-such-cv-facts.json'),
      format: 'text',
    });
    assert.equal(result.verdict, 'block');
  });
});

test('tab, break and noBreakHyphen survive the tag scan', () => {
  const inner = `<w:r>${t('w', 'team')}</w:r><w:r><w:tab/></w:r><w:r>${t('w', 'of')}</w:r><w:r><w:br/></w:r><w:r>${t('w', '2019')}</w:r><w:r><w:noBreakHyphen/></w:r><w:r>${t('w', '2024')}</w:r>`;
  const zip = packDocx({ 'word/document.xml': wmlDocument('w', `<w:p>${inner}</w:p>`) });
  const text = extractDocxText(zip);
  assert.match(text, /team\tof/);
  assert.match(text, /of\n2019/);
  assert.match(text, /2019-2024/);
});

test('numeric XML entities decode before amp', () => {
  assert.equal(unescapeXml('&#8217;'), '\u2019');
  assert.equal(unescapeXml('&#x2019;'), '\u2019');
  assert.equal(unescapeXml('&amp;#52;0'), '&#52;0');
});

test('an empty Word document fails instead of passing', () => {
  withDir('career-ops-facts-docx-empty-', (dir) => {
    writeFileSync(join(dir, 'cv.md'), resume('Led a team of 4 engineers.'));
    const empty = writePacked(dir, 'empty.docx', {
      'word/document.xml': wmlDocument('w', paragraph('w', '')),
    });
    assert.throws(() => extractDocxText(readFileSync(empty)), /no readable text in \.docx/);
    const r = runCli(empty, { dataRoot: dir });
    assert.equal(r.status, 1);
    assert.match(`${r.stdout}${r.stderr}`, /no readable text in \.docx/);
  });
});

test('.docm and .dotx go through the extractor; .pdf .doc .odt are refused', () => {
  withDir('career-ops-facts-docx-ext-', (dir) => {
    writeFileSync(join(dir, 'cv.md'), resume('Led a team of 4 engineers.'));
    const packed = packDocx({
      'word/document.xml': wmlDocument('w', paragraph('w', t('w', 'Led a team of 40 engineers.'))),
    });
    for (const ext of ['.docm', '.dotx']) {
      const file = join(dir, `cv${ext}`);
      writeFileSync(file, packed);
      assert.match(readGeneratedText(file), /40 engineers/);
      const r = runCli(file, { dataRoot: dir, extra: ['--json'] });
      assert.equal(r.status, 1, ext);
      assert.equal(JSON.parse(r.stdout).verdict, 'block');
    }
    for (const ext of ['.pdf', '.doc', '.odt']) {
      const file = join(dir, `cv${ext}`);
      writeFileSync(file, '%PDF-1.4 6x 4% fake');
      assert.throws(() => readGeneratedText(file), /gate the \.md\/\.html source instead/);
    }
  });
});

test('a zip bomb padding entry is not inflated and a huge entry is refused', () => {
  const honest = packDocx({
    'word/document.xml': wmlDocument('w', paragraph('w', t('w', 'Led a team of 40 engineers.'))),
    'word/padding.bin': Buffer.alloc(64, 7),
  });
  const bomb = setDeclaredUncompSize(honest, 'word/padding.bin', MAX_ZIP_ENTRY_BYTES + 1024);
  const text = extractDocxText(bomb);
  assert.match(text, /40 engineers/);
  assert.throws(() => readZip(bomb), /exceeds/);
  assert.throws(
    () => readZipEntries(bomb, ['word/padding.bin']),
    /exceeds/,
  );
});

test('corrupt offsets surface as Corrupt .docx, not a raw RangeError', () => {
  withDir('career-ops-facts-docx-corrupt-', (dir) => {
    writeFileSync(join(dir, 'cv.md'), resume('Led a team of 4 engineers.'));
    const truncated = join(dir, 'trunc.docx');
    writeFileSync(truncated, packDocx({
      'word/document.xml': wmlDocument('w', paragraph('w', t('w', 'Led a team of 40 engineers.'))),
    }).subarray(0, 40));
    assert.throws(() => readGeneratedText(truncated), /Corrupt \.docx:/);
    const r = runCli(truncated, { dataRoot: dir });
    assert.equal(r.status, 1);
    assert.match(`${r.stdout}${r.stderr}`, /Corrupt \.docx:/);
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /RangeError/);
  });
});

test('an unclosed paragraph tag is scanned in linear time', () => {
  const junk = `<w:p ${'x'.repeat(80)}`.repeat(200);
  const xml = wmlDocument('w', `${junk}${paragraph('w', t('w', 'Led a team of 40 engineers.'))}`);
  const zip = packDocx({ 'word/document.xml': xml });
  const start = Date.now();
  const text = extractDocxText(zip);
  assert.ok(Date.now() - start < 500, 'tag scan took too long');
  assert.match(text, /40 engineers/);
});
