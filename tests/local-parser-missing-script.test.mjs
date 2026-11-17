// tests/local-parser-missing-script.test.mjs — a configured local_parser whose
// script is missing or unrunnable must be named, not folded into "N skipped".
import { execFileSync, spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { pass, fail, ROOT, NODE, rmSync } from './helpers.mjs';

console.log('\nlocal-parser — missing/unrunnable script is a loud failure');

const tmp = mkdtempSync(join(tmpdir(), 'co-missing-parser-'));
const reports = join(tmp, 'reports');
mkdirSync(reports, { recursive: true });
mkdirSync(join(tmp, 'data'), { recursive: true });
writeFileSync(join(tmp, 'data', 'applications.md'), `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
`);
writeFileSync(join(tmp, 'data', 'pipeline.md'), '# Pipeline\n\n');
writeFileSync(join(tmp, 'applications.md'), `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
`, 'utf-8');

const missingEntry = `  - name: Missing Parser Board
    careers_url: https://www.linkedin.com/jobs/search/?keywords=test
    scan_method: local_parser
    parser:
      command: node
      script: scripts/parsers/definitely-missing-xyz.mjs
      format: jobs-json-v1
    enabled: true
`;
const okGreenhouse = `  - name: Claimed Co
    provider: greenhouse
    careers_url: https://boards.greenhouse.io/claimedco
    enabled: true
`;

try {
  const localParserModule = await import(pathToFileURL(join(ROOT, 'providers/local-parser.mjs')).href);
  const localParser = localParserModule.default;
  const { inspectParserScript } = localParserModule;

  const missing = {
    name: 'Missing Parser Board',
    careers_url: 'https://www.linkedin.com/jobs/search/?keywords=test',
    parser: { command: 'node', script: 'scripts/parsers/definitely-missing-xyz.mjs' },
  };
  const hit = localParser.detect(missing);
  if (hit && hit.url) pass('detect() still claims a board whose parser script is missing');
  else fail(`detect() skipped a missing-script board: ${JSON.stringify(hit)}`);

  const issue = inspectParserScript(missing);
  if (issue?.status === 'missing' && /not found/.test(issue.error || '')) {
    pass('inspectParserScript() reports status=missing with a not-found error');
  } else {
    fail(`inspect missing drifted: ${JSON.stringify(issue)}`);
  }

  try {
    await localParser.fetch(missing);
    fail('fetch() should throw when the parser script is missing');
  } catch (err) {
    if (/not found/.test(err.message)) pass('fetch() throws a named "parser script not found" error');
    else fail(`fetch missing error drifted: ${err.message}`);
  }

  const unrunnable = {
    name: 'Dir Parser Board',
    careers_url: 'https://example.com/jobs',
    parser: { command: 'node', script: 'scripts' },
  };
  const unrunIssue = inspectParserScript(unrunnable);
  if (unrunIssue?.status === 'unrunnable') pass('a directory used as parser.script is unrunnable, not a silent skip');
  else fail(`unrunnable inspect drifted: ${JSON.stringify(unrunIssue)}`);
  if (localParser.detect(unrunnable)?.url) pass('detect() claims an unrunnable parser script so fetch() can name it');
  else fail('detect() skipped an unrunnable parser script');

  const { findUnclaimedEntries, auditCompanies } = await import(pathToFileURL(join(ROOT, 'audit-portals.mjs')).href);
  const claimed = findUnclaimedEntries([
    { ...missing, enabled: true },
    { name: 'Silent Co', careers_url: 'https://nobody.example.com', enabled: true },
  ], new Map([['local-parser', localParser]]));
  if (claimed.brokenParser?.length === 1 && claimed.brokenParser[0].name === 'Missing Parser Board'
    && claimed.silent.length === 1 && claimed.silent[0].name === 'Silent Co') {
    pass('findUnclaimedEntries() puts a missing parser in brokenParser, not silent skip');
  } else {
    fail(`unclaimed buckets drifted: ${JSON.stringify(claimed)}`);
  }

  const auditRows = await auditCompanies(
    [{ ...missing, enabled: true }],
    { providers: new Map([['local-parser', localParser]]), concurrency: 1 },
  );
  if (auditRows.length === 1 && auditRows[0].verdict === 'error' && /not found/.test(auditRows[0].detail || '')) {
    pass('audit-portals reports a missing parser as error, not no-provider');
  } else {
    fail(`auditCompanies drifted: ${JSON.stringify(auditRows)}`);
  }

  const portals = join(tmp, 'portals.yml');
  writeFileSync(portals, `title_filter:\n  positive:\n    - Engineer\njob_boards:\n${missingEntry}`);
  const scan = spawnSync(NODE, [join(ROOT, 'scan.mjs'), '--dry-run'], {
    cwd: tmp,
    env: { ...process.env, CAREER_OPS_ROOT: tmp, CAREER_OPS_PORTALS: portals },
    encoding: 'utf-8',
    timeout: 30_000,
  });
  const scanOut = `${scan.stdout}${scan.stderr}`;
  const named = /Missing Parser Board/.test(scanOut) && /not found|parser script/.test(scanOut);
  const silentSkipOnly = /1 skipped — no provider matched/.test(scanOut) && !/Errors/.test(scanOut);
  if (named && !silentSkipOnly) pass('scan summary names the missing parser instead of skipping the board silently');
  else fail(`scan missing-parser output:\n${scanOut}`);

  const vpPortals = join(tmp, 'vp-portals.yml');
  writeFileSync(vpPortals, `tracked_companies:\n${okGreenhouse}job_boards:\n${missingEntry}`, 'utf-8');
  let vpOut = '';
  try {
    vpOut = execFileSync(NODE, [join(ROOT, 'verify-pipeline.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        CAREER_OPS_TRACKER: join(tmp, 'applications.md'),
        CAREER_OPS_REPORTS: reports,
        CAREER_OPS_PORTALS: vpPortals,
      },
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60_000,
    });
  } catch (err) {
    vpOut = typeof err.stdout === 'string' ? err.stdout : '';
  }
  if (/Missing Parser Board/.test(vpOut) && /not found|unrunnable|missing/.test(vpOut)) {
    pass('verify-pipeline Check 15 errors on a missing local parser script');
  } else {
    fail(`check 15 missing-parser output:\n${vpOut.split('\n').filter((l) => /portals\.yml|Parser|resolve to a provider/i.test(l)).join('\n')}`);
  }
} catch (err) {
  fail(`missing-parser tests crashed: ${err.stack || err.message}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
