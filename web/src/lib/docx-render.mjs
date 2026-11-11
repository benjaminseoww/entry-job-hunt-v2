/**
 * docx-render.mjs — persist tailored markdown, render Word, mark the tracker.
 *
 * Mirrors pdf-render.mjs: the agent emits <<cv-md>>, the backend writes the
 * .md, generate-docx.mjs renders it, mark-pdf-ready.mjs flips the tracker
 * cell. No agent writes. Word is US Letter only.
 */
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { getProfilePath } from "./core/profile-path.mjs";
import { slugify } from "./pdf-paths.mjs";
import { markTrackerReady } from "./pdf-render.mjs";

/**
 * @typedef {Object} DocxPaths
 * @property {string} reportNum
 * @property {string} reportFile
 * @property {string} md
 * @property {string} finalDocx
 */

/**
 * @param {string} input
 * @param {string} today
 * @param {string} root
 * @param {(input: string) => string | null} findReportFile
 * @returns {{ok: true, paths: DocxPaths} | {ok: false, error: string}}
 */
export function resolveDocxPaths(input, today, root, findReportFile) {
  if (!/^\d+$/.test(input)) {
    return { ok: false, error: `Invalid report selector: "${input}"` };
  }
  const reportFile = findReportFile(input);
  if (!reportFile) {
    return { ok: false, error: `No report #${input} found — evaluate this posting first.` };
  }
  const reportName = path.basename(reportFile);
  const reportNum = (reportName.match(/^(\d+)-/)?.[1] ?? input)
    .replace(/^0+(?=\d)/, "")
    .padStart(3, "0");
  const companyMatch = reportName.match(/^\d+-(.+)-\d{4}-\d{2}-\d{2}\.md$/);
  const companySlug = companyMatch ? companyMatch[1] : "company";
  let candidateSlug = "candidate";
  try {
    const profile = yaml.load(fs.readFileSync(getProfilePath(root), "utf8"));
    if (profile?.candidate?.full_name) candidateSlug = slugify(profile.candidate.full_name);
  } catch (err) {
    if (err?.code !== "ENOENT") {
      console.warn(`resolveDocxPaths: could not read/parse config/profile.yml, defaulting candidate slug: ${err.message}`);
    }
  }
  const stem = `cv-${candidateSlug}-${reportNum}-${companySlug}-${today}`;
  fs.mkdirSync(path.join(root, "output"), { recursive: true });
  return {
    ok: true,
    paths: {
      reportNum,
      reportFile: path.relative(root, reportFile).split(path.sep).join("/"),
      md: path.join(root, "output", `${stem}.md`),
      finalDocx: path.join(root, "output", `${stem}.docx`),
    },
  };
}

/**
 * @param {{ envelope: object|undefined, noOutputMessage: string|null, sawError: boolean, cleanExit: boolean, hasPaths: boolean }} signals
 * @returns {{ok: true} | {ok: false, message: string}}
 */
export function docxRunOutcome({ envelope, noOutputMessage, sawError, cleanExit, hasPaths }) {
  if (noOutputMessage) return { ok: false, message: noOutputMessage };
  if (envelope?.ok !== true || !cleanExit || sawError || !hasPaths) {
    const why = envelope && envelope.ok === false ? ` (${envelope.error})` : "";
    return {
      ok: false,
      message: `This run didn't produce a tailored CV to render, so no Word file was generated — re-run it to verify.${why}`,
    };
  }
  return { ok: true };
}

/**
 * @param {{docxPaths: {md: string}, markdown: string}} args
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function writeCvMarkdown({ docxPaths, markdown }) {
  try {
    fs.mkdirSync(path.dirname(docxPaths.md), { recursive: true });
    fs.writeFileSync(docxPaths.md, markdown, "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Could not save the tailored CV to ${err.path ?? docxPaths.md}: ${err.message}` };
  }
}

/**
 * @param {{spawnFn: Function, execPath: string, root: string, md: string, finalDocx: string, reportNum: string}} args
 * @returns {Promise<{ok: boolean, stderr: string}>}
 */
export function spawnGenerateDocx({ spawnFn, execPath, root, md, finalDocx, reportNum }) {
  return new Promise((resolve) => {
    const child = spawnFn(
      execPath,
      [path.join(root, "generate-docx.mjs"), md, finalDocx, `--report=${reportNum}`],
      { cwd: root },
    );
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ ok: code === 0, stderr: stderr.trim() }));
    child.on("error", (e) => resolve({ ok: false, stderr: `Word rendering failed to start: ${e.message}` }));
  });
}

/**
 * @param {{spawnFn: Function, execPath: string, root: string, docxPaths: {md: string, finalDocx: string}, reportNum: string}} args
 * @returns {Promise<{kind: "render-failed", error: string} | {kind: "rendered", warnings: string[]}>}
 */
export async function renderAndMarkDocx({ spawnFn, execPath, root, docxPaths, reportNum }) {
  const warnings = [];
  const render = await spawnGenerateDocx({
    spawnFn,
    execPath,
    root,
    md: docxPaths.md,
    finalDocx: docxPaths.finalDocx,
    reportNum,
  });
  if (!render.ok) {
    return { kind: "render-failed", error: render.stderr || "Word rendering failed." };
  }
  for (const line of render.stderr.split("\n")) {
    const text = line.trim();
    if (text) warnings.push(text);
  }
  const mark = await markTrackerReady({ spawnFn, execPath, root, reportNum });
  if (!mark.ok) {
    console.error(`mark-pdf-ready.mjs failed for report #${reportNum}: ${mark.data?.error ?? mark.stderr}`);
    warnings.push(
      mark.data?.error
        ? `Word file rendered, but the tracker wasn't updated: ${mark.data.error}`
        : `Word file rendered, but the tracker's CV column wasn't updated automatically — run \`node mark-pdf-ready.mjs ${reportNum}\` manually.`,
    );
  }
  return { kind: "rendered", warnings };
}
