// tests/verify-ats-docx.test.mjs — verify-ats.mjs scores Word and markdown
// on text-level checks only. Layout checks that need HTML are listed as
// n/a; the HTML path stays the historical scorer.
//
// Run:  node --test tests/verify-ats-docx.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDocx } from '../generate-docx.mjs';
import { extractDocxParts, extractDocxText } from '../lib/docx-text.mjs';
import { readZip, writeZip } from '../lib/docx-zip.mjs';
import {
  HTML_ONLY_CHECKS,
  DOCX_NA_CHECKS,
  auditAts,
  auditAtsFromPath,
  extractPlainHeadings,
  isPass,
  DEFAULT_MIN_SCORE,
} from '../verify-ats.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const CLEAN_RESUME = `# CV -- Jane Smith

**Email:** jane@example.com
**Phone:** +1 415 555 0100
**Location:** San Francisco, CA

## Professional Summary

Senior backend engineer with a decade of designing reliable, high-throughput
distributed systems. Led platform teams delivering resilient services on
Kubernetes, with a focus on observability, cost efficiency, and clean,
well-tested Python codebases used daily across the organization.

## Work Experience

### Acme Corp -- San Francisco, CA

**Staff Engineer**
Jan 2020 – Present

- Built and operated the core payments platform, reducing incident rates and
  improving deployment cadence across multiple engineering teams.

## Education

### State University -- CA

**B.S. Computer Science**
2018

## Skills

- **Languages:** Python, Kubernetes, Docker, PostgreSQL
- **Tools:** distributed systems, CI/CD pipelines

## Projects

### Tracing toolkit -- open source

**Maintainer**
2022 – Present

- Open-source tracing toolkit adopted by several teams for latency debugging.

## Certifications

Certified Kubernetes Administrator (CNCF), 2022.
`;

const CLEAN_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<style>body{font-family:'Liberation Sans',Arial,sans-serif;} .section-title{font-weight:700;}</style></head><body>
<div class="header"><h1>Jane Smith</h1>
<div class="contact-row"><a href="mailto:jane@example.com">jane@example.com</a> | +1 415 555 0100 | Remote</div></div>
<div class="section"><div class="section-title">Professional Summary</div><p>Senior backend engineer with a
decade building reliable, high-throughput distributed systems on Kubernetes, with a focus on observability,
cost efficiency and clean, well-tested Python services used daily across the organization.</p></div>
<div class="section"><div class="section-title">Work Experience</div><p>Staff Engineer, Acme Corp
(2020-present). Built and operated the core payments platform across multiple engineering teams.</p></div>
<div class="section"><div class="section-title">Education</div><p>B.S. Computer Science, 2018.</p></div>
<div class="section"><div class="section-title">Skills</div><p>Python, Kubernetes, Docker, PostgreSQL.</p></div>
</body></html>`;

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-ats-docx-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function writeDocx(dir, name, markdown = CLEAN_RESUME) {
  const md = join(dir, `${name}.md`);
  const docx = join(dir, `${name}.docx`);
  writeFileSync(md, markdown);
  const result = generateDocx({ input: md, output: docx, skipFactCheck: true });
  assert.equal(result.ok, true, result.error ?? 'generateDocx failed');
  return { md, docx };
}

function runCli(file, extra = []) {
  return spawnSync(process.execPath, [join(ROOT, 'verify-ats.mjs'), file, ...extra], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 60_000,
  });
}

function parseJson(proc) {
  assert.equal(proc.error, undefined, proc.error?.message);
  const json = JSON.parse(proc.stdout);
  return json;
}

test('markdown ATX headings and Word uppercase titles are both recognized', () => {
  const mdHeadings = extractPlainHeadings(CLEAN_RESUME, { kind: 'md' });
  assert.ok(mdHeadings.some((h) => h.includes('work experience')));
  assert.ok(mdHeadings.some((h) => h.includes('education')));
  assert.ok(mdHeadings.some((h) => h.includes('skills')));

  const wordHeadings = extractPlainHeadings('JANE SMITH\nWORK EXPERIENCE\nStaff Engineer\nEDUCATION\nSKILLS\n', { kind: 'docx' });
  assert.ok(wordHeadings.some((h) => h.includes('work experience')));
  assert.ok(wordHeadings.some((h) => h.includes('education')));
  assert.ok(wordHeadings.some((h) => h.includes('skills')));
  assert.equal(wordHeadings.some((h) => h.includes('jane smith')), false);
  // Two-character caseless section titles (Hangul / Han) match the term list.
  const cjk = extractPlainHeadings('학력\n경력\n기술\n学歴\n技能\n', { kind: 'docx' });
  assert.ok(cjk.some((h) => h.includes('학력')));
  assert.ok(cjk.some((h) => h.includes('경력')));
  assert.ok(cjk.some((h) => h.includes('기술')));
  assert.ok(cjk.some((h) => h.includes('学歴')));
  assert.ok(cjk.some((h) => h.includes('技能')));
  // All-caps acronym / employer lines are not fallback headings.
  const acronyms = extractPlainHeadings('AWS GCP K8S SRE\nTECHFIN CORP\nNASA JPL\n', { kind: 'docx' });
  assert.equal(acronyms.length, 0);
  // Sentence-case body copy containing "experience" is not a heading.
  const body = extractPlainHeadings('Senior engineer with a decade of experience designing systems.\n', { kind: 'docx' });
  assert.equal(body.some((h) => h.includes('experience')), false);
  // Markdown has ATX headings; all-caps body lines are not headings.
  const mdCaps = extractPlainHeadings('WORK EXPERIENCE\nStaff Engineer\nEDUCATION\nSKILLS\n', { kind: 'md' });
  assert.equal(mdCaps.some((h) => h.includes('work experience')), false);
});

test('node verify-ats.mjs on a .md fixture scores text checks and lists n/a checks', () => {
  withDir((dir) => {
    const md = join(dir, 'cv-jane-smith.md');
    writeFileSync(md, CLEAN_RESUME);
    const proc = runCli(md, ['--json']);
    const json = parseJson(proc);
    assert.equal(proc.status, 0, proc.stderr || proc.stdout);
    assert.equal(json.pass, true);
    assert.ok(json.score >= 80, `expected a high markdown score, got ${json.score}`);
    assert.deepEqual(json.naChecks, HTML_ONLY_CHECKS);
    for (const check of HTML_ONLY_CHECKS) {
      assert.ok(
        json.issues.some((i) => i.severity === 'info' && i.message === `${check}: n/a for markdown`),
        `missing n/a issue for ${check}`,
      );
    }
    assert.equal(json.issues.some((i) => String(i.message).includes('<table>')), false);
  });
});

test('node verify-ats.mjs on a .docx fixture returns a score that lists n/a for Word', () => {
  withDir((dir) => {
    const { docx } = writeDocx(dir, 'cv-jane-smith');
    const proc = runCli(docx, ['--json', '--keywords', 'python,kubernetes,rust']);
    const json = parseJson(proc);
    assert.equal(proc.status, 0, proc.stderr || proc.stdout);
    assert.equal(json.pass, true);
    assert.ok(json.score >= 80, `expected a high Word score, got ${json.score}`);
    assert.deepEqual(json.naChecks, DOCX_NA_CHECKS);
    for (const check of DOCX_NA_CHECKS) {
      assert.ok(
        json.issues.some((i) => i.severity === 'info' && i.message === `${check}: n/a for Word`),
        `missing n/a issue for ${check}`,
      );
    }
    for (const check of ['layout', 'images', 'hidden']) {
      assert.equal(
        json.issues.some((i) => i.message === `${check}: n/a for Word`),
        false,
        `${check} should be scored on Word, not n/a`,
      );
    }
    assert.equal(json.keywordCoverage.total, 3);
    assert.equal(json.keywordCoverage.found, 2);
    assert.deepEqual(json.keywordCoverage.missing, ['rust']);
    assert.equal(
      json.issues.some((i) => i.severity !== 'info' && /<table>|multi-column|non-standard font|charset/i.test(i.message)),
      false,
    );
  });
});

test('a markdown CV missing required headings is flagged, and n/a checks still list', () => {
  withDir((dir) => {
    const md = join(dir, 'thin.md');
    writeFileSync(md, `# CV -- Jane Smith

**Email:** jane@example.com

## Professional Summary

${'Reliable systems work. '.repeat(20)}
`);
    const proc = runCli(md, ['--json']);
    const json = parseJson(proc);
    assert.equal(proc.status, 1);
    assert.equal(json.pass, false);
    assert.ok(json.issues.some((i) => /missing standard section/i.test(i.message)));
    assert.ok(json.issues.some((i) => /Education/i.test(i.message) && /Skills/i.test(i.message)));
    assert.deepEqual(json.naChecks, HTML_ONLY_CHECKS);
  });
});

test('HTML path is unchanged: no naChecks field, tables still fail', () => {
  withDir((dir) => {
    const clean = join(dir, 'clean-cv.html');
    const hostile = join(dir, 'hostile-cv.html');
    writeFileSync(clean, CLEAN_HTML);
    writeFileSync(hostile, `<html><head><style>body{font-family:'Comic Sans MS',cursive;}</style></head><body>
<table><tr><td><img src="skills.png"></td><td><h1>John</h1></td></tr>
<tr><td>Experience</td><td>2020</td></tr></table></body></html>`);

    const cleanRes = runCli(clean, ['--json']);
    const cleanJson = parseJson(cleanRes);
    assert.equal(cleanRes.status, 0);
    assert.equal(cleanJson.pass, true);
    assert.ok(cleanJson.score >= 80);
    assert.equal('naChecks' in cleanJson, false);
    assert.equal(cleanJson.issues.some((i) => /n\/a for Word/i.test(i.message)), false);

    const imported = auditAts(CLEAN_HTML);
    assert.equal('naChecks' in imported, false);
    assert.equal(imported.score, cleanJson.score);

    const hostileRes = runCli(hostile, ['--json']);
    const hostileJson = parseJson(hostileRes);
    const messages = hostileJson.issues.map((i) => i.message.toLowerCase());
    assert.equal(hostileRes.status, 1);
    assert.equal(hostileJson.pass, false);
    assert.equal('naChecks' in hostileJson, false);
    assert.ok(messages.some((m) => m.includes('<table>')));
    assert.ok(messages.some((m) => m.includes('education') || m.includes('skills')));
  });
});

test('auditAtsFromPath reads .docx through lib/docx-text.mjs, not as zip bytes', () => {
  withDir((dir) => {
    const { docx } = writeDocx(dir, 'cv-path');
    const raw = readFileSync(docx, 'utf-8');
    assert.ok(raw.startsWith('PK'), 'fixture must be a zip');
    const asHtml = auditAts(raw);
    assert.ok(!isPass(asHtml, DEFAULT_MIN_SCORE), 'zip bytes must not look like a passing HTML CV');
    const fromPath = auditAtsFromPath(docx);
    assert.equal(isPass(fromPath, DEFAULT_MIN_SCORE), true);
    assert.deepEqual(fromPath.naChecks, DOCX_NA_CHECKS);
  });
});

test('modes/ats.md documents the Word text-level path', () => {
  const mode = readFileSync(join(ROOT, 'modes', 'ats.md'), 'utf-8');
  assert.match(mode, /verify-ats\.mjs output\/cv-jane-smith-acme\.docx --json/);
  assert.match(mode, /n\/a for Word/);
  assert.match(mode, /lib\/docx-text\.mjs/);
  assert.match(mode, /The HTML path is unchanged/);
  assert.match(mode, /awarded in full/);
  assert.match(mode, /not comparable/);
  assert.match(mode, /\.markdown/);
  assert.match(mode, /w:webHidden/);
  assert.match(mode, /styles\.xml/);
  assert.match(mode, /Known Word hidden-text limits/);
  const docxMode = readFileSync(join(ROOT, 'modes', 'docx.md'), 'utf-8');
  assert.match(docxMode, /verify-ats\.mjs/);
  assert.match(docxMode, /modes\/ats\.md/);
});

const RU_RESUME = `# CV -- Иван Петров

**Email:** ivan@example.com
**Phone:** +7 495 555 0100

## Опыт работы

### Яндекс -- Москва

**Старший инженер**
2020 – 2024

- Разработал и поддерживал платформу платежей, сократив количество инцидентов и ускорив выпуск релизов в нескольких командах инженеров по всей компании.
- Руководил командой из трёх инженеров, внедрил наблюдаемость и автоматические тесты для всех критичных сервисов платформы.

## Образование

### МГУ -- Москва

**Бакалавр информатики**
2018

## Навыки

- Python, Kubernetes, PostgreSQL, Kafka, распределённые системы
`;

const JA_RESUME = `# CV -- Иван Петров

**Email:** ivan@example.com
**Phone:** +7 495 555 0100

## 職務経歴

### Яндекс -- Москва

**Старший инженер**
2020 – 2024

- Разработал и поддерживал платформу платежей, сократив количество инцидентов и ускорив выпуск релизов в нескольких командах инженеров по всей компании.
- Руководил командой из трёх инженеров, внедрил наблюдаемость и автоматические тесты для всех критичных сервисов платформы.

## 学歴

### МГУ -- Москва

**Бакалавр информатики**
2018

## スキル

- Python, Kubernetes, PostgreSQL, Kafka, распределённые системы
`;

function rewriteDocx(buffer, mutators) {
  const entries = [];
  for (const [name, data] of readZip(buffer)) {
    if (mutators[name]) entries.push({ name, data: mutators[name](data.toString('utf8')) });
    else entries.push({ name, data });
  }
  return writeZip(entries);
}

function titleCaseHeadings(xml) {
  let out = xml;
  for (const h of ['PROFESSIONAL SUMMARY', 'WORK EXPERIENCE', 'EDUCATION', 'SKILLS', 'PROJECTS', 'CERTIFICATIONS']) {
    out = out.replace(`>${h}<`, `>${h.replace(/\w+/g, (w) => w[0] + w.slice(1).toLowerCase())}<`);
  }
  return out;
}

function wrapBodyInTable(xml) {
  const start = xml.indexOf('<w:body>') + 8;
  const sect = xml.indexOf('<w:sectPr');
  const end = sect >= 0 ? sect : xml.indexOf('</w:body>');
  const body = xml.slice(start, end);
  const ps = body.match(/<w:p>[\s\S]*?<\/w:p>/g) || [];
  const h = Math.floor(ps.length / 2);
  const table = `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="6000"/></w:tblGrid><w:tr><w:tc>${ps.slice(h).join('')}</w:tc><w:tc>${ps.slice(0, h).join('')}</w:tc></w:tr></w:tbl><w:p/>`;
  return xml.slice(0, start) + table + xml.slice(end);
}

function moveEmailToFooter(docXml, footerXml, email) {
  const paras = docXml.match(/<w:p>[\s\S]*?<\/w:p>/g) || [];
  const contact = paras.find((p) => p.includes(email));
  assert.ok(contact, 'generated docx must contain a contact paragraph');
  const nextDoc = docXml.replace(contact, '');
  const nextFooter = /<w:p>[\s\S]*?<\/w:p>/.test(footerXml)
    ? footerXml.replace(/<w:p>[\s\S]*?<\/w:p>/, contact)
    : footerXml.replace('</w:ftr>', `${contact}</w:ftr>`);
  return { doc: nextDoc, footer: nextFooter };
}

function injectBeforeSectPr(xml, snippet) {
  if (xml.includes('<w:sectPr')) return xml.replace('<w:sectPr', `${snippet}<w:sectPr`);
  return xml.replace('</w:body>', `${snippet}</w:body>`);
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function wmlDoc(inner) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${inner}</w:body></w:document>`;
}

function normalP(text, rPr = '') {
  const rpr = rPr ? `<w:rPr>${rPr}</w:rPr>` : '';
  return `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r>${rpr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function stripGeneratorHeadingPr(xml) {
  return xml
    .replaceAll('<w:keepNext/>', '')
    .replace(/<w:pBdr>[\s\S]*?<\/w:pBdr>/g, '');
}

const ATS_PADDING = 'selectable text for the ATS parser to read. '.repeat(10);

function writePartsDocx(dir, name, entries) {
  const path = join(dir, name);
  writeFileSync(path, writeZip(entries));
  return path;
}

function missingSectionIssue(json) {
  return json.issues.some((i) => /missing standard section/i.test(i.message));
}

test('Russian and Japanese Word CVs from generateDocx keep their section headings', () => {
  withDir((dir) => {
    for (const [name, markdown] of [['ru', RU_RESUME], ['ja', JA_RESUME]]) {
      const { md, docx } = writeDocx(dir, name, markdown);
      const mdProc = runCli(md, ['--json']);
      const docxProc = runCli(docx, ['--json']);
      const mdJson = parseJson(mdProc);
      const docxJson = parseJson(docxProc);
      assert.equal(mdProc.status, 0, mdProc.stderr || mdProc.stdout);
      assert.equal(docxProc.status, 0, docxProc.stderr || docxProc.stdout);
      assert.equal(mdJson.pass, true, `${name}.md should pass`);
      assert.equal(missingSectionIssue(mdJson), false, `${name}.md must not miss sections`);
      assert.equal(docxJson.pass, true, `${name}.docx should pass: ${JSON.stringify(docxJson.issues)}`);
      assert.equal(missingSectionIssue(docxJson), false, `${name}.docx must not miss sections: ${JSON.stringify(docxJson.issues)}`);
    }
  });
});

test('Title Case and w:caps Word headings still score as sections', () => {
  withDir((dir) => {
    const { docx } = writeDocx(dir, 'cv-headings');
    const src = readFileSync(docx);
    const titlecase = join(dir, 'v-titlecase.docx');
    const wcaps = join(dir, 'v-wcaps.docx');
    writeFileSync(titlecase, rewriteDocx(src, {
      'word/document.xml': (xml) => stripGeneratorHeadingPr(titleCaseHeadings(xml)),
    }));
    writeFileSync(wcaps, rewriteDocx(src, {
      'word/document.xml': (xml) => stripGeneratorHeadingPr(titleCaseHeadings(xml)).replaceAll('<w:b/>', '<w:b/><w:caps/>'),
    }));
    for (const file of [titlecase, wcaps]) {
      const proc = runCli(file, ['--json']);
      const json = parseJson(proc);
      assert.equal(proc.status, 0, `${file}: ${proc.stderr || proc.stdout}`);
      assert.equal(json.pass, true);
      assert.equal(missingSectionIssue(json), false, `${file} missing sections: ${JSON.stringify(json.issues)}`);
    }
  });
});

test('unstyled Title Case and w:caps headings in Normal style still score', () => {
  withDir((dir) => {
    const titleInner = [
      normalP('Jane Smith'),
      normalP('jane@example.com'),
      normalP('Work Experience'),
      normalP(`Staff Engineer, Acme. ${ATS_PADDING}`),
      normalP('Education'),
      normalP('B.S. Computer Science, 2018.'),
      normalP('Skills'),
      normalP('Python, Kubernetes, Docker'),
    ].join('');
    const capsInner = [
      normalP('Jane Smith'),
      normalP('jane@example.com'),
      normalP('Work Experience', '<w:caps/>'),
      normalP(`Staff Engineer, Acme. ${ATS_PADDING}`),
      normalP('Education', '<w:caps/>'),
      normalP('B.S. Computer Science, 2018.'),
      normalP('Skills', '<w:caps/>'),
      normalP('Python, Kubernetes, Docker'),
    ].join('');
    const titlePath = writePartsDocx(dir, 'unstyled-titlecase.docx', [{ name: 'word/document.xml', data: wmlDoc(titleInner) }]);
    const capsPath = writePartsDocx(dir, 'unstyled-wcaps.docx', [{ name: 'word/document.xml', data: wmlDoc(capsInner) }]);
    for (const file of [titlePath, capsPath]) {
      const parts = extractDocxParts(readFileSync(file));
      assert.equal(parts.headings.length, 0, `${file} must not rely on XML heading pPr`);
      const json = auditAtsFromPath(file);
      assert.equal(missingSectionIssue(json), false, `${file}: ${JSON.stringify(json.issues)}`);
      assert.equal(isPass(json, DEFAULT_MIN_SCORE), true, `${file} score=${json.score}`);
    }
  });
});

test('unstyled Korean, Japanese, and Chinese Word CVs keep two-character section headings', () => {
  withDir((dir) => {
    const locales = [
      { name: 'ko', headings: ['경력', '학력', '기술'] },
      { name: 'ja', headings: ['職務経歴', '学歴', 'スキル'] },
      { name: 'zh', headings: ['工作经历', '教育背景', '技能'] },
    ];
    for (const { name, headings } of locales) {
      const inner = [
        normalP('Jane Smith'),
        normalP('jane@example.com'),
        normalP(headings[0]),
        normalP(`Staff Engineer, Acme. ${ATS_PADDING}`),
        normalP(headings[1]),
        normalP('B.S. Computer Science, 2018.'),
        normalP(headings[2]),
        normalP('Python, Kubernetes, Docker'),
      ].join('');
      const file = writePartsDocx(dir, `unstyled-${name}.docx`, [{ name: 'word/document.xml', data: wmlDoc(inner) }]);
      const json = auditAtsFromPath(file);
      assert.equal(missingSectionIssue(json), false, `${name}: ${JSON.stringify(json.issues)}`);
      assert.equal(isPass(json, DEFAULT_MIN_SCORE), true, `${name} score=${json.score} ${JSON.stringify(json.issues)}`);
    }
  });
});

test('Word Heading1 / Title / outlineLvl XML styles are headings without relying on case', () => {
  withDir((dir) => {
    const inner = [
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Work Experience</w:t></w:r></w:p>',
      '<w:p><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:r><w:t>Education</w:t></w:r></w:p>',
      '<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Skills</w:t></w:r></w:p>',
      `<w:p><w:r><w:t>jane@example.com ${'selectable text '.repeat(30)}</w:t></w:r></w:p>`,
    ].join('');
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${inner}</w:body></w:document>`;
    const path = join(dir, 'styled.docx');
    writeFileSync(path, writeZip([{ name: 'word/document.xml', data: xml }]));
    const parts = extractDocxParts(readFileSync(path));
    assert.ok(parts.headings.some((h) => /work experience/i.test(h)));
    assert.ok(parts.headings.some((h) => /education/i.test(h)));
    assert.ok(parts.headings.some((h) => /skills/i.test(h)));
    const json = auditAtsFromPath(path);
    assert.equal(missingSectionIssue(json), false, JSON.stringify(json.issues));
  });
});

test('email only in the Word footer is a Word-worded critical', () => {
  withDir((dir) => {
    const { docx } = writeDocx(dir, 'cv-footer');
    const src = readFileSync(docx);
    const moved = rewriteDocx(src, {
      'word/document.xml': (xml) => {
        const footer = readZip(src).get('word/footer1.xml').toString('utf8');
        return moveEmailToFooter(xml, footer, 'jane@example.com').doc;
      },
      'word/footer1.xml': (xml) => {
        const doc = readZip(src).get('word/document.xml').toString('utf8');
        return moveEmailToFooter(doc, xml, 'jane@example.com').footer;
      },
    });
    const path = join(dir, 'v-contact-footer.docx');
    writeFileSync(path, moved);
    const parts = extractDocxParts(readFileSync(path));
    assert.equal(parts.body.includes('jane@example.com'), false);
    assert.equal(parts.headerFooter.includes('jane@example.com'), true);
    const proc = runCli(path, ['--json']);
    const json = parseJson(proc);
    assert.equal(proc.status, 1);
    assert.equal(json.pass, false);
    assert.ok(json.issues.some((i) => i.severity === 'critical' && /Word header\/footer/i.test(i.message)));
  });
});

test('Word tables, vanished runs, and white/tiny text are scored (not n/a)', () => {
  withDir((dir) => {
    const { docx } = writeDocx(dir, 'cv-layout');
    const src = readFileSync(docx);
    const tablePath = join(dir, 'v-table.docx');
    const vanishPath = join(dir, 'v-vanish.docx');
    const whitePath = join(dir, 'v-white.docx');
    writeFileSync(tablePath, rewriteDocx(src, { 'word/document.xml': wrapBodyInTable }));
    writeFileSync(vanishPath, rewriteDocx(src, {
      'word/document.xml': (xml) => injectBeforeSectPr(xml, '<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>zzqrust zzqgolang terraform</w:t></w:r></w:p>'),
    }));
    writeFileSync(whitePath, rewriteDocx(src, {
      'word/document.xml': (xml) => injectBeforeSectPr(xml, '<w:p><w:r><w:rPr><w:color w:val="FFFFFF"/><w:sz w:val="2"/></w:rPr><w:t>zzqrust zzqgolang terraform</w:t></w:r></w:p>'),
    }));

    const tableJson = parseJson(runCli(tablePath, ['--json']));
    assert.equal(tableJson.pass, false);
    assert.ok(tableJson.issues.some((i) => i.severity === 'critical' && /<w:tbl>|Word table/i.test(i.message)));

    const vanishBuf = readFileSync(vanishPath);
    assert.match(extractDocxText(vanishBuf), /zzqrust/);
    const vanishParts = extractDocxParts(vanishBuf);
    assert.equal(vanishParts.bodyVisible.includes('zzqrust'), false);
    assert.ok(vanishParts.hiddenSignals.includes('w:vanish'));
    const vanishJson = parseJson(runCli(vanishPath, ['--json', '--keywords', 'zzqrust,zzqgolang']));
    assert.ok(vanishJson.issues.some((i) => /hidden text/i.test(i.message) && /w:vanish/.test(i.message)));
    assert.equal(vanishJson.keywordCoverage.found, 0);
    assert.deepEqual(vanishJson.keywordCoverage.missing, ['zzqrust', 'zzqgolang']);

    const whiteJson = parseJson(runCli(whitePath, ['--json', '--keywords', 'zzqrust,zzqgolang']));
    assert.ok(whiteJson.issues.some((i) => /hidden text/i.test(i.message)));
    assert.equal(whiteJson.keywordCoverage.found, 0);
  });
});

test('Word text boxes and multi-column sections are flagged under layout', () => {
  withDir((dir) => {
    const inner = [
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Work Experience</w:t></w:r></w:p>',
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Education</w:t></w:r></w:p>',
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Skills</w:t></w:r></w:p>',
      `<w:p><w:r><w:drawing><w:txbxContent><w:p><w:r><w:t>jane@example.com ${'selectable text '.repeat(30)}</w:t></w:r></w:p></w:txbxContent></w:drawing></w:r></w:p>`,
      '<w:sectPr><w:cols w:num="2"/></w:sectPr>',
    ].join('');
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${inner}</w:body></w:document>`;
    const path = join(dir, 'v-box.docx');
    writeFileSync(path, writeZip([{ name: 'word/document.xml', data: xml }]));
    const parts = extractDocxParts(readFileSync(path));
    assert.ok(parts.textBoxes >= 1);
    assert.equal(parts.multiColumn, true);
    assert.ok(parts.images >= 1);
    const json = auditAtsFromPath(path);
    assert.ok(json.issues.some((i) => /text box/i.test(i.message)));
    assert.ok(json.issues.some((i) => /multi-column/i.test(i.message)));
    assert.ok(json.issues.some((i) => /drawing\/pict/i.test(i.message)));
  });
});

test('CLI refuses .pdf/.doc/.rtf and accepts .markdown / uppercase .DOCX', () => {
  withDir((dir) => {
    const { md, docx } = writeDocx(dir, 'cv-case');
    const markdown = join(dir, 'cv-case.markdown');
    writeFileSync(markdown, readFileSync(md, 'utf-8'));
    const upper = join(dir, 'UPPER.DOCX');
    writeFileSync(upper, readFileSync(docx));
    const mdProc = runCli(markdown, ['--json']);
    const mdJson = parseJson(mdProc);
    assert.equal(mdProc.status, 0, mdProc.stderr || mdProc.stdout);
    assert.deepEqual(mdJson.naChecks, HTML_ONLY_CHECKS);
    const upperProc = runCli(upper, ['--json']);
    const upperJson = parseJson(upperProc);
    assert.equal(upperProc.status, 0, upperProc.stderr);
    assert.deepEqual(upperJson.naChecks, DOCX_NA_CHECKS);

    for (const ext of ['.pdf', '.doc', '.rtf']) {
      const file = join(dir, `scan${ext}`);
      writeFileSync(file, '%PDF-1.4 fake');
      const proc = runCli(file, ['--json']);
      assert.equal(proc.status, 1);
      assert.match(proc.stderr, /score the \.html\/\.md\/\.docx instead/);
      assert.equal(proc.stdout.trim(), '');
    }
  });
});

test('CLI reports Corrupt .docx on stderr for unreadable Word files, even with --json', () => {
  withDir((dir) => {
    const zero = join(dir, 'zero.docx');
    const fake = join(dir, 'fake.docx');
    const nodoc = join(dir, 'nodoc.docx');
    const trunc = join(dir, 'trunc.docx');
    writeFileSync(zero, '');
    writeFileSync(fake, '<html>hi</html>\n');
    writeFileSync(nodoc, writeZip([{
      name: '[Content_Types].xml',
      data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
    }]));
    const { docx } = writeDocx(dir, 'cv-trunc');
    writeFileSync(trunc, readFileSync(docx).subarray(0, 80));

    for (const file of [zero, fake, nodoc, trunc]) {
      const proc = runCli(file, ['--json']);
      assert.equal(proc.status, 1, file);
      assert.match(proc.stderr, /Corrupt \.docx/);
      assert.equal(proc.stdout.trim(), '');
    }
  });
});

test('a vanished body email does not earn the contact points', () => {
  withDir((dir) => {
    const inner = [
      normalP('Jane Smith'),
      `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:rPr><w:vanish/></w:rPr><w:t>jane@example.com</w:t></w:r></w:p>`,
      normalP('Work Experience'),
      normalP(`Staff Engineer, Acme. ${ATS_PADDING}`),
      normalP('Education'),
      normalP('B.S. Computer Science, 2018.'),
      normalP('Skills'),
      normalP('Python, Kubernetes, Docker'),
    ].join('');
    const file = writePartsDocx(dir, 'v-email-vanish.docx', [{ name: 'word/document.xml', data: wmlDoc(inner) }]);
    const parts = extractDocxParts(readFileSync(file));
    assert.equal(parts.body.includes('jane@example.com'), true);
    assert.equal(parts.bodyVisible.includes('jane@example.com'), false);
    const json = auditAtsFromPath(file);
    assert.equal(isPass(json, DEFAULT_MIN_SCORE), false);
    assert.ok(json.issues.some((i) => i.severity === 'critical' && /hidden in the document body/i.test(i.message)));
    assert.equal(json.issues.some((i) => /header\/footer/i.test(i.message)), false);
  });
});

test('footer tables, footer logos, and white header names are not scored against the body', () => {
  withDir((dir) => {
    const inner = [
      normalP('Jane Smith'),
      normalP('jane@example.com'),
      normalP('Work Experience'),
      normalP(`Staff Engineer, Acme. ${ATS_PADDING}`),
      normalP('Education'),
      normalP('B.S. Computer Science, 2018.'),
      normalP('Skills'),
      normalP('Python, Kubernetes, Docker'),
    ].join('');
    const header = `<?xml version="1.0" encoding="UTF-8"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:rPr><w:color w:val="FFFFFF"/></w:rPr><w:t>JANE SMITH</w:t></w:r></w:p></w:hdr>`;
    const footer = `<?xml version="1.0" encoding="UTF-8"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:tbl><w:tr><w:tc><w:p><w:r><w:t>page</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:drawing></w:drawing></w:r></w:p></w:ftr>`;
    const file = writePartsDocx(dir, 'v-header-footer-chrome.docx', [
      { name: 'word/document.xml', data: wmlDoc(inner) },
      { name: 'word/header1.xml', data: header },
      { name: 'word/footer1.xml', data: footer },
    ]);
    const parts = extractDocxParts(readFileSync(file));
    assert.equal(parts.tables, 0);
    assert.equal(parts.images, 0);
    assert.equal(parts.hiddenSignals.length, 0);
    const json = auditAtsFromPath(file);
    assert.equal(isPass(json, DEFAULT_MIN_SCORE), true, JSON.stringify(json.issues));
    assert.equal(json.issues.some((i) => /<w:tbl>|Word table/i.test(i.message)), false);
    assert.equal(json.issues.some((i) => /drawing\/pict/i.test(i.message)), false);
    assert.equal(json.issues.some((i) => /hidden text/i.test(i.message)), false);
  });
});

test('webHidden, near-white, themeColor, highlight, and styles.xml hidden runs are flagged', () => {
  withDir((dir) => {
    const styles = `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="character" w:styleId="HiddenRun"><w:rPr><w:vanish/><w:webHidden/></w:rPr></w:style></w:styles>`;
    const inner = [
      normalP('Jane Smith'),
      normalP('jane@example.com'),
      normalP('Work Experience'),
      normalP(`Staff Engineer, Acme. ${ATS_PADDING}`),
      normalP('Education'),
      normalP('B.S. Computer Science, 2018.'),
      normalP('Skills'),
      normalP('Python, Kubernetes, Docker'),
      `<w:p><w:r><w:rPr><w:webHidden/></w:rPr><w:t>zzqwebhidden</w:t></w:r></w:p>`,
      `<w:p><w:r><w:rPr><w:color w:val="F8F8F8"/></w:rPr><w:t>zzqnearwhite</w:t></w:r></w:p>`,
      `<w:p><w:r><w:rPr><w:color w:themeColor="background1"/></w:rPr><w:t>zzqtheme</w:t></w:r></w:p>`,
      `<w:p><w:r><w:rPr><w:highlight w:val="white"/></w:rPr><w:t>zzqhighlight</w:t></w:r></w:p>`,
      `<w:p><w:r><w:rPr><w:rStyle w:val="HiddenRun"/></w:rPr><w:t>zzqstylerust</w:t></w:r></w:p>`,
    ].join('');
    const file = writePartsDocx(dir, 'v-hidden-extra.docx', [
      { name: 'word/document.xml', data: wmlDoc(inner) },
      { name: 'word/styles.xml', data: styles },
    ]);
    const buf = readFileSync(file);
    assert.match(extractDocxText(buf), /zzqstylerust/);
    const parts = extractDocxParts(buf);
    assert.equal(parts.bodyVisible.includes('zzqwebhidden'), false);
    assert.equal(parts.bodyVisible.includes('zzqnearwhite'), false);
    assert.equal(parts.bodyVisible.includes('zzqtheme'), false);
    assert.equal(parts.bodyVisible.includes('zzqhighlight'), false);
    assert.equal(parts.bodyVisible.includes('zzqstylerust'), false);
    assert.ok(parts.hiddenSignals.includes('w:webHidden'));
    assert.ok(parts.hiddenSignals.includes('near-white text'));
    assert.ok(parts.hiddenSignals.includes('themeColor'));
    assert.ok(parts.hiddenSignals.includes('white highlight'));
    assert.ok(parts.hiddenSignals.includes('w:vanish'));
    const json = auditAtsFromPath(file);
    assert.ok(json.issues.some((i) => /hidden text/i.test(i.message)));
    const covered = parseJson(runCli(file, ['--json', '--keywords', 'zzqwebhidden,zzqstylerust']));
    assert.equal(covered.keywordCoverage.found, 0);
  });
});
