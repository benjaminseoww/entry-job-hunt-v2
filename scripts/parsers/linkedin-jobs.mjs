#!/usr/bin/env node
// LinkedIn guest job-search parser for scan.mjs `local_parser` boards.
// Walks the public no-login seeMore endpoint; no detail-page fetches in v1.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { decodeEntities } from '../../providers/_html-entities.mjs';
import { linkedInPathJobId } from '../../lib/linkedin-url.mjs';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { BROWSER_LIKE_USER_AGENT } from '../../user-agent.mjs';

export const GUEST_SEARCH_ORIGIN = 'https://www.linkedin.com';
export const GUEST_SEARCH_PATH = '/jobs-guest/jobs/api/seeMoreJobPostings/search';
export const DEFAULT_TPR = 'r604800';
export const PAGE_SIZE = 10;
export const DELAY_MIN_MS = 2_500;
export const DELAY_MAX_MS = 6_000;
export const DEFAULT_BUDGET_MS = 80_000;
export const REQUEST_TIMEOUT_MS = 8_000;
export const MAX_RETRIES = 3;
export const LOCK_STALE_MS = 180_000;
export const KEPT_QUERY_KEYS = Object.freeze(['keywords', 'location', 'geoId', 'f_TPR']);

const LOCK_NAME = '.linkedin-jobs.lock';

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function defaultLockPath() {
  const dataDir = join(getCareerOpsRoot(), 'data');
  if (existsSync(dataDir)) return join(dataDir, LOCK_NAME);
  return join(tmpdir(), `career-ops${LOCK_NAME}`);
}

export function guestSearchUrl(careersUrl, start = 0) {
  let src;
  try {
    src = new URL(String(careersUrl));
  } catch {
    throw new Error(`linkedin-jobs: careers_url is not a valid URL: ${careersUrl}`);
  }
  if (src.protocol !== 'http:' && src.protocol !== 'https:') {
    throw new Error(`linkedin-jobs: careers_url must be http(s): ${careersUrl}`);
  }

  const dest = new URL(GUEST_SEARCH_PATH, GUEST_SEARCH_ORIGIN);
  for (const key of KEPT_QUERY_KEYS) {
    const value = src.searchParams.get(key);
    if (value) dest.searchParams.set(key, value);
  }
  if (!dest.searchParams.has('f_TPR')) dest.searchParams.set('f_TPR', DEFAULT_TPR);
  dest.searchParams.set('start', String(Math.max(0, Number(start) || 0)));
  return dest.href;
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function matchGroup(html, re) {
  const match = String(html).match(re);
  return match ? stripTags(match[1]) : '';
}

function jobViewUrl(id) {
  return `${GUEST_SEARCH_ORIGIN}/jobs/view/${id}`;
}

function idFromHref(href) {
  if (!href) return null;
  try {
    return linkedInPathJobId(new URL(href.replace(/&amp;/g, '&'), GUEST_SEARCH_ORIGIN));
  } catch {
    return null;
  }
}

function parseOneCard(card, fallbackId) {
  const urn = card.match(/urn:li:jobPosting:(\d+)/);
  const href = matchGroup(card, /href="((?:https?:\/\/[^"]*linkedin\.com)?\/jobs\/view\/[^"]+)"/i);
  const id = urn?.[1] || idFromHref(href) || fallbackId;
  const title = matchGroup(
    card,
    /<h3[^>]*class="[^"]*(?:base-search-card__title|job-search-card__title)[^"]*"[^>]*>([\s\S]*?)<\/h3>/i,
  );
  if (!id || !title) return null;

  const company = matchGroup(
    card,
    /<h4[^>]*class="[^"]*(?:base-search-card__subtitle|job-search-card__subtitle)[^"]*"[^>]*>([\s\S]*?)<\/h4>/i,
  ) || matchGroup(card, /<a[^>]*class="[^"]*hidden-nested-link[^"]*"[^>]*>([\s\S]*?)<\/a>/i);

  const location = matchGroup(
    card,
    /<span[^>]*class="[^"]*job-search-card__location[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
  );
  const postedAt = card.match(/<time[^>]*datetime="([^"]+)"/i)?.[1];

  const job = { title, company, location, url: jobViewUrl(id), jobId: id };
  if (postedAt) job.postedAt = postedAt;
  return job;
}

export function parseJobCards(html) {
  const source = String(html || '');
  if (!source.trim()) return [];

  const jobs = [];
  const seen = new Set();
  const urns = [];
  const urnRe = /data-entity-urn="urn:li:jobPosting:(\d+)"/g;
  let match;
  while ((match = urnRe.exec(source))) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    urns.push({ id: match[1], index: match.index });
  }

  for (let i = 0; i < urns.length; i++) {
    const start = urns[i].index;
    const end = i + 1 < urns.length ? urns[i + 1].index : source.length;
    const job = parseOneCard(source.slice(start, end), urns[i].id);
    if (job) jobs.push(job);
  }

  if (jobs.length > 0) return jobs;

  const hrefRe = /href="((?:https?:\/\/[^"]*linkedin\.com)?\/jobs\/view\/[^"]+)"/gi;
  while ((match = hrefRe.exec(source))) {
    const id = idFromHref(match[1]);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const windowStart = Math.max(0, match.index - 800);
    const windowEnd = Math.min(source.length, match.index + 2_000);
    const job = parseOneCard(source.slice(windowStart, windowEnd), id);
    if (job) jobs.push(job);
  }
  return jobs;
}

export function isAuthwall({ status, location, body } = {}) {
  const code = Number(status);
  if (code === 999 || code === 401 || code === 403) return true;
  const loc = String(location || '');
  if (code >= 300 && code < 400 && /authwall|session_redirect|\/(?:uas\/)?login/i.test(loc)) {
    return true;
  }
  const text = String(body || '');
  return /class="[^"]*authwall|id="authwall"|\/checkpoint\/lg\/login/i.test(text);
}

export function isRetryableStatus(status) {
  const code = Number(status);
  return code === 429 || (code >= 500 && code <= 599);
}

export function pageDelayMs(random = Math.random) {
  return DELAY_MIN_MS + random() * (DELAY_MAX_MS - DELAY_MIN_MS);
}

export function backoffMs(attempt, random = Math.random) {
  const base = Math.min(8_000, 1_000 * (2 ** attempt));
  return base + random() * 250;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireLock(lockPath, { now = Date.now, staleMs = LOCK_STALE_MS, retried = false } = {}) {
  mkdirSync(dirname(lockPath), { recursive: true });
  try {
    const fd = openSync(lockPath, 'wx');
    try {
      writeFileSync(fd, `${process.pid}\n${now()}\n`);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }

  let stale = false;
  try {
    const st = statSync(lockPath);
    const ownerPid = Number((readFileSync(lockPath, 'utf8').split('\n')[0] || '').trim());
    stale = !pidAlive(ownerPid) || (now() - st.mtimeMs) > staleMs;
  } catch {
    stale = true;
  }
  if (!stale || retried) return false;

  try { unlinkSync(lockPath); } catch { return false; }
  return acquireLock(lockPath, { now, staleMs, retried: true });
}

export function releaseLock(lockPath) {
  try { unlinkSync(lockPath); } catch { /* already gone */ }
}

function requestHeaders(userAgent) {
  return {
    'User-Agent': userAgent || BROWSER_LIKE_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-SG,en;q=0.9',
    Referer: `${GUEST_SEARCH_ORIGIN}/jobs/search`,
  };
}

function responseMeta(res) {
  return {
    status: res.status,
    location: res.headers?.get?.('location') || res.headers?.get?.('Location') || null,
    retryAfter: res.headers?.get?.('retry-after') || res.headers?.get?.('Retry-After') || null,
  };
}

async function fetchPage(url, { fetchImpl, userAgent, now, deadline }) {
  const remaining = deadline - now();
  if (remaining <= 0) {
    const err = new Error('linkedin-jobs: time budget exhausted');
    err.code = 'BUDGET';
    throw err;
  }
  const timeout = Math.min(REQUEST_TIMEOUT_MS, Math.max(1, remaining));
  return fetchImpl(url, {
    headers: requestHeaders(userAgent),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeout),
  });
}

function retryAfterMs(header, random) {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 8_000);
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) return Math.min(Math.max(0, dateMs - Date.now()), 8_000);
  return backoffMs(0, random);
}

/**
 * Crawl the guest search endpoint. Injectable fetch/sleep/now/lock for tests.
 * Stops at max-pages, an empty page, a page with no new IDs, authwall, or budget.
 */
export async function scanLinkedInJobs(options = {}) {
  const careersUrl = options.careersUrl;
  if (!careersUrl) throw new Error('linkedin-jobs: careers_url is required');

  const maxPages = Math.max(1, Number(options.maxPages) || 20);
  const budgetMs = Math.max(1_000, Number(options.budgetMs) || DEFAULT_BUDGET_MS);
  const fetchImpl = options.fetchImpl || globalThis.fetch.bind(globalThis);
  const sleep = options.sleep || defaultSleep;
  const now = options.now || Date.now;
  const random = options.random || Math.random;
  const lockPath = options.lockPath || defaultLockPath();
  const warn = options.warn || (() => {});
  const userAgent = options.userAgent || BROWSER_LIKE_USER_AGENT;
  const started = now();
  const deadline = started + budgetMs;

  if (!acquireLock(lockPath, { now })) {
    throw new Error(`linkedin-jobs: another scan is already running (lock: ${lockPath})`);
  }

  const jobs = [];
  const seenIds = new Set();
  let warning;

  try {
    for (let page = 0; page < maxPages; page++) {
      if (page > 0) {
        const delay = pageDelayMs(random);
        if (deadline - now() < delay + REQUEST_TIMEOUT_MS) {
          warning = 'stopped early to finish within timeout';
          break;
        }
        await sleep(delay);
      }

      const url = guestSearchUrl(careersUrl, page * PAGE_SIZE);
      let body = '';
      let meta = { status: 0, location: null, retryAfter: null };
      let stopped = false;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (deadline - now() < 1_000) {
          warning = 'stopped early to finish within timeout';
          stopped = true;
          break;
        }
        let res;
        try {
          res = await fetchPage(url, { fetchImpl, userAgent, now, deadline });
        } catch (err) {
          if (err?.code === 'BUDGET') {
            warning = 'stopped early to finish within timeout';
            stopped = true;
            break;
          }
          if (attempt >= MAX_RETRIES) {
            warning = `network error: ${err.message}`;
            stopped = true;
            break;
          }
          await sleep(backoffMs(attempt, random));
          continue;
        }

        meta = responseMeta(res);
        body = typeof res.text === 'function' ? await res.text() : '';

        if (isAuthwall({ ...meta, body })) {
          warning = `authwall (HTTP ${meta.status || 'redirect'}); returning ${jobs.length} job(s) already collected`;
          stopped = true;
          break;
        }
        if (isRetryableStatus(meta.status)) {
          if (attempt >= MAX_RETRIES) {
            warning = `persistent HTTP ${meta.status}; returning ${jobs.length} job(s) already collected`;
            stopped = true;
            break;
          }
          const wait = retryAfterMs(meta.retryAfter, random) ?? backoffMs(attempt, random);
          if (deadline - now() < wait + 1_000) {
            warning = `HTTP ${meta.status} with no time left to retry; returning ${jobs.length} job(s) already collected`;
            stopped = true;
            break;
          }
          await sleep(wait);
          continue;
        }
        if (meta.status < 200 || meta.status >= 300) {
          warning = `HTTP ${meta.status}; returning ${jobs.length} job(s) already collected`;
          stopped = true;
          break;
        }
        break;
      }

      if (stopped) break;

      const pageJobs = parseJobCards(body);
      if (pageJobs.length === 0) break;

      let added = 0;
      for (const job of pageJobs) {
        if (seenIds.has(job.jobId)) continue;
        seenIds.add(job.jobId);
        jobs.push(job);
        added++;
      }
      if (added === 0) break;
    }
  } finally {
    releaseLock(lockPath);
  }

  if (warning) warn(warning);
  return { jobs, warning };
}

export function parseArgv(argv = process.argv.slice(2)) {
  const out = { maxPages: 20, budgetMs: DEFAULT_BUDGET_MS, careersUrl: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--max-pages') out.maxPages = Number(argv[++i]);
    else if (arg === '--budget-ms') out.budgetMs = Number(argv[++i]);
    else if (!arg.startsWith('-') && !out.careersUrl) out.careersUrl = arg;
  }
  return out;
}

export const USAGE = `Usage:
  node scripts/parsers/linkedin-jobs.mjs [--max-pages N] [--budget-ms MS] <careers_url>

Walks LinkedIn's public guest search endpoint and prints jobs-json-v1 on stdout.
`;

async function main() {
  const args = parseArgv();
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (!args.careersUrl) {
    process.stderr.write(USAGE);
    process.exitCode = 1;
    return;
  }

  try {
    const result = await scanLinkedInJobs({
      careersUrl: args.careersUrl,
      maxPages: args.maxPages,
      budgetMs: args.budgetMs,
      warn: (msg) => process.stderr.write(`linkedin-jobs: ${msg}\n`),
    });
    process.stdout.write(`${JSON.stringify({ jobs: result.jobs })}\n`);
  } catch (err) {
    process.stderr.write(`linkedin-jobs: ${err.message}\n`);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  await main();
}
