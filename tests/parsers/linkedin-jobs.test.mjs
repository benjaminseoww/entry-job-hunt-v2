// tests/parsers/linkedin-jobs.test.mjs — offline LinkedIn guest-search parser.
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { pass, fail, ROOT } from '../helpers.mjs';

console.log('\nParser — LinkedIn guest job search');

const fixture = (name) => readFileSync(join(ROOT, 'tests', 'fixtures', name), 'utf8');
const PAGE = fixture('linkedin-jobs-page.html');
const PAGE2 = fixture('linkedin-jobs-page-2.html');
const EMPTY = fixture('linkedin-jobs-empty.html');
const AUTHWALL = fixture('linkedin-jobs-authwall.html');
const HREF_ONLY = fixture('linkedin-jobs-href-only.html');

const SEARCH = 'https://www.linkedin.com/jobs/search/?keywords=%28Junior%20OR%20Graduate%29%20AND%20%28%22Software%20Engineer%22%29&location=Singapore&geoId=102454443&f_TPR=r604800&f_JT=F';

const tmp = mkdtempSync(join(tmpdir(), 'li-jobs-'));
const lockPath = join(tmp, '.linkedin-jobs.lock');

const load = async () => import(pathToFileURL(join(ROOT, 'scripts/parsers/linkedin-jobs.mjs')).href);

function htmlResponse(html, status = 200, headers = {}) {
  const headerInit = { 'content-type': 'text/html', ...headers };
  // LinkedIn's 999 anti-bot status is outside Fetch's 200–599 Response range.
  if (status >= 200 && status <= 599) return new Response(html, { status, headers: headerInit });
  const map = new Headers(headerInit);
  return { status, headers: map, text: async () => html };
}

try {
  const mod = await load();
  const {
    guestSearchUrl, parseJobCards, scanLinkedInJobs, isAuthwall,
    pageDelayMs, backoffMs, parseArgv, PAGE_SIZE, DEFAULT_TPR, GUEST_SEARCH_PATH,
  } = mod;

  // ── URL translation ──
  const page0 = new URL(guestSearchUrl(SEARCH, 0));
  const page1 = new URL(guestSearchUrl(SEARCH, PAGE_SIZE));
  if (page0.origin + page0.pathname === `https://www.linkedin.com${GUEST_SEARCH_PATH}`) {
    pass('guest URL uses the public seeMoreJobPostings endpoint');
  } else {
    fail(`guest path drifted: ${page0.href}`);
  }
  if (page0.searchParams.get('keywords')?.includes('Junior')
    && page0.searchParams.get('location') === 'Singapore'
    && page0.searchParams.get('geoId') === '102454443'
    && page0.searchParams.get('f_TPR') === 'r604800'
    && page0.searchParams.get('start') === '0'
    && !page0.searchParams.has('f_JT')) {
    pass('guest URL keeps keywords/location/geoId/f_TPR, drops f_JT, starts at 0');
  } else {
    fail(`guest params drifted: ${page0.href}`);
  }
  if (page1.searchParams.get('start') === '10') pass('page 2 uses start=10 (10 cards per page)');
  else fail(`page 2 start=${page1.searchParams.get('start')}`);

  const noTpr = new URL(guestSearchUrl('https://www.linkedin.com/jobs/search/?keywords=eng&location=Singapore&geoId=102454443'));
  if (noTpr.searchParams.get('f_TPR') === DEFAULT_TPR) pass('missing f_TPR defaults to past week (r604800)');
  else fail(`default f_TPR=${noTpr.searchParams.get('f_TPR')}`);

  const alreadyGuest = guestSearchUrl(`https://www.linkedin.com${GUEST_SEARCH_PATH}?keywords=eng&start=90`, 0);
  if (new URL(alreadyGuest).searchParams.get('start') === '0') {
    pass('an already-guest URL is rebuilt and paging starts at 0');
  } else {
    fail(`rebuilt start=${alreadyGuest}`);
  }

  try {
    guestSearchUrl('not a url');
    fail('guestSearchUrl should reject a non-URL');
  } catch (err) {
    if (/not a valid URL/.test(err.message)) pass('guestSearchUrl rejects a non-URL');
    else fail(`unexpected URL error: ${err.message}`);
  }

  // ── Card parsing ──
  const cards = parseJobCards(PAGE);
  const byId = Object.fromEntries(cards.map((j) => [j.jobId, j]));
  if (cards.length === 3) pass('page fixture parses 3 job cards');
  else fail(`parsed ${cards.length}: ${JSON.stringify(cards.map((j) => j.jobId))}`);

  const grab = byId['4123456789'];
  if (grab?.title === 'Junior Software Engineer'
    && grab.company === 'Grab'
    && grab.location === 'Singapore, Singapore'
    && grab.url === 'https://www.linkedin.com/jobs/view/4123456789'
    && grab.postedAt === '2026-11-14') {
    pass('card fields: title, company, location, canonical /jobs/view/<id>, postedAt from <time datetime>');
  } else {
    fail(`Grab card drifted: ${JSON.stringify(grab)}`);
  }

  if (byId['4555000111']?.title === 'AI Engineer I & Platform' && byId['4555000111']?.company === 'Acme & Co') {
    pass('HTML entities in title/company are decoded');
  } else {
    fail(`entity decode drifted: ${JSON.stringify(byId['4555000111'])}`);
  }

  const hrefOnly = parseJobCards(HREF_ONLY);
  if (hrefOnly.length === 1 && hrefOnly[0].jobId === '4001112222' && hrefOnly[0].title === 'New Grad Software Engineer') {
    pass('cards without data-entity-urn still parse from /jobs/view/<id> hrefs');
  } else {
    fail(`href-only parse drifted: ${JSON.stringify(hrefOnly)}`);
  }

  if (parseJobCards(EMPTY).length === 0 && parseJobCards('').length === 0) {
    pass('empty HTML yields no cards');
  } else {
    fail('empty HTML should yield no cards');
  }

  // ── Authwall detector ──
  if (isAuthwall({ status: 999 }) && isAuthwall({ status: 403 })
    && isAuthwall({ status: 302, location: 'https://www.linkedin.com/authwall?session_redirect=/jobs' })
    && isAuthwall({ status: 200, body: AUTHWALL })
    && !isAuthwall({ status: 200, body: PAGE })) {
    pass('authwall fires on 999/403/login-redirect/authwall HTML, not on a normal card page');
  } else {
    fail('authwall detector drifted');
  }

  // ── Paging / stop / dedupe (mocked fetch, no network) ──
  const hits = [];
  const sleepLog = [];
  const pages = { 0: PAGE, 10: PAGE2, 20: EMPTY };
  const fetchByStart = async (url) => {
    hits.push(url);
    const start = Number(new URL(url).searchParams.get('start'));
    return htmlResponse(pages[start] ?? '');
  };

  const paged = await scanLinkedInJobs({
    careersUrl: SEARCH,
    maxPages: 20,
    budgetMs: 60_000,
    fetchImpl: fetchByStart,
    sleep: async (ms) => { sleepLog.push(ms); },
    now: () => 0,
    random: () => 0,
    lockPath,
  });
  const ids = paged.jobs.map((j) => j.jobId);
  if (ids.join(',') === '4123456789,4987654321,4555000111,4666777888') {
    pass('paging keeps new IDs and dedupes the overlapping card from page 2');
  } else {
    fail(`paged ids=${ids.join(',')}`);
  }
  if (hits.length === 3) pass('scan stops on the empty third page');
  else fail(`expected 3 fetches (empty stop), got ${hits.length}`);

  const noNewPages = { 0: PAGE, 10: PAGE };
  let noNewHits = 0;
  const noNew = await scanLinkedInJobs({
    careersUrl: SEARCH,
    maxPages: 5,
    budgetMs: 60_000,
    fetchImpl: async () => { noNewHits++; return htmlResponse(noNewPages[(noNewHits - 1) * 10] ?? PAGE); },
    sleep: async () => {},
    now: () => 0,
    random: () => 0,
    lockPath: join(tmp, 'nonew.lock'),
  });
  if (noNewHits === 2 && noNew.jobs.length === 3) {
    pass('scan stops when a page adds no new IDs');
  } else {
    fail(`no-new-ids: hits=${noNewHits} jobs=${noNew.jobs.length}`);
  }

  let cappedHits = 0;
  await scanLinkedInJobs({
    careersUrl: SEARCH,
    maxPages: 1,
    budgetMs: 60_000,
    fetchImpl: async () => { cappedHits++; return htmlResponse(PAGE); },
    sleep: async () => {},
    now: () => 0,
    lockPath: join(tmp, 'cap.lock'),
  });
  if (cappedHits === 1) pass('--max-pages 1 fetches a single page');
  else fail(`max-pages hits=${cappedHits}`);

  // ── 429 retry / backoff ──
  let rateHits = 0;
  const rateSleep = [];
  const recovered = await scanLinkedInJobs({
    careersUrl: SEARCH,
    maxPages: 1,
    budgetMs: 60_000,
    fetchImpl: async () => {
      rateHits++;
      if (rateHits < 3) return htmlResponse('rate limit', 429, { 'retry-after': '1' });
      return htmlResponse(PAGE);
    },
    sleep: async (ms) => { rateSleep.push(ms); },
    now: () => 0,
    random: () => 0,
    lockPath: join(tmp, '429.lock'),
  });
  if (rateHits === 3 && recovered.jobs.length === 3 && rateSleep.length === 2) {
    pass('HTTP 429 retries with backoff, then returns the page');
  } else {
    fail(`429 retry: hits=${rateHits} jobs=${recovered.jobs.length} sleeps=${rateSleep.length}`);
  }

  const stuck = await scanLinkedInJobs({
    careersUrl: SEARCH,
    maxPages: 1,
    budgetMs: 60_000,
    fetchImpl: async () => htmlResponse('nope', 429),
    sleep: async () => {},
    now: () => 0,
    random: () => 0,
    lockPath: join(tmp, 'stuck.lock'),
  });
  if (stuck.jobs.length === 0 && /persistent HTTP 429/.test(stuck.warning || '')) {
    pass('persistent 429 stops cleanly and returns whatever was collected');
  } else {
    fail(`persistent 429 drifted: ${JSON.stringify(stuck)}`);
  }

  const serverErr = await scanLinkedInJobs({
    careersUrl: SEARCH,
    maxPages: 1,
    budgetMs: 60_000,
    fetchImpl: async () => htmlResponse('down', 503),
    sleep: async () => {},
    now: () => 0,
    random: () => 0,
    lockPath: join(tmp, '503.lock'),
  });
  if (/persistent HTTP 503/.test(serverErr.warning || '')) pass('5xx retries then stops cleanly');
  else fail(`5xx warning=${serverErr.warning}`);

  // ── Authwall stop ──
  const wall = await scanLinkedInJobs({
    careersUrl: SEARCH,
    maxPages: 5,
    budgetMs: 60_000,
    fetchImpl: async () => htmlResponse(AUTHWALL, 999),
    sleep: async () => {},
    now: () => 0,
    lockPath: join(tmp, 'auth.lock'),
  });
  if (wall.jobs.length === 0 && /authwall/.test(wall.warning || '')) {
    pass('authwall/999 stops cleanly with a warning and whatever jobs were collected');
  } else {
    fail(`authwall drifted: ${JSON.stringify(wall)}`);
  }

  let afterAuth = 0;
  const mixed = await scanLinkedInJobs({
    careersUrl: SEARCH,
    maxPages: 5,
    budgetMs: 60_000,
    fetchImpl: async (url) => {
      afterAuth++;
      const start = Number(new URL(url).searchParams.get('start'));
      if (start === 0) return htmlResponse(PAGE);
      return new Response('', { status: 302, headers: { location: 'https://www.linkedin.com/authwall?trk=login' } });
    },
    sleep: async () => {},
    now: () => 0,
    random: () => 0,
    lockPath: join(tmp, 'mixed.lock'),
  });
  if (mixed.jobs.length === 3 && afterAuth === 2 && /authwall/.test(mixed.warning || '')) {
    pass('authwall after a successful page keeps the collected jobs and does not keep paging');
  } else {
    fail(`mixed authwall: jobs=${mixed.jobs.length} hits=${afterAuth} warn=${mixed.warning}`);
  }

  // ── Delay range + time budget ──
  const delays = [pageDelayMs(() => 0), pageDelayMs(() => 1), pageDelayMs(() => 0.5)];
  if (delays[0] === 2_500 && delays[1] === 6_000 && delays[2] > 2_500 && delays[2] < 6_000) {
    pass('inter-page delay is randomized in 2.5–6s');
  } else {
    fail(`delay range drifted: ${delays}`);
  }
  if (backoffMs(0, () => 0) === 1_000 && backoffMs(3, () => 0) === 8_000) {
    pass('retry backoff is exponential and capped');
  } else {
    fail(`backoff drifted: ${[backoffMs(0, () => 0), backoffMs(3, () => 0)]}`);
  }

  let clock = 0;
  const budgeted = await scanLinkedInJobs({
    careersUrl: SEARCH,
    maxPages: 20,
    budgetMs: 5_000,
    fetchImpl: async () => htmlResponse(PAGE),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    random: () => 0,
    lockPath: join(tmp, 'budget.lock'),
  });
  if (budgeted.jobs.length === 3 && /timeout/.test(budgeted.warning || '')) {
    pass('time budget stops paging before the 90s exec timeout');
  } else {
    fail(`budget drifted: jobs=${budgeted.jobs.length} warn=${budgeted.warning}`);
  }

  // ── Concurrent lock ──
  writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`);
  try {
    await scanLinkedInJobs({
      careersUrl: SEARCH,
      maxPages: 1,
      fetchImpl: async () => htmlResponse(PAGE),
      sleep: async () => {},
      now: () => Date.now(),
      lockPath,
    });
    fail('a live lock should refuse a concurrent run');
  } catch (err) {
    if (/already running/.test(err.message)) pass('lock file refuses a concurrent LinkedIn scan');
    else fail(`lock error drifted: ${err.message}`);
  }

  const argv = parseArgv(['--max-pages', '20', SEARCH]);
  if (argv.maxPages === 20 && argv.careersUrl === SEARCH) pass('CLI parses --max-pages and the careers_url');
  else fail(`argv drifted: ${JSON.stringify(argv)}`);
} catch (err) {
  fail(`linkedin-jobs tests crashed: ${err.stack || err.message}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
