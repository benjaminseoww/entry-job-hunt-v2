/** Scratch markdown, then promote to output/ only after exit 0 so a blocked fact gate never overwrites the companion. */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { getProfilePath } from "./core/profile-path.mjs";
import { slugify } from "./pdf-paths.mjs";
import { markTrackerReady } from "./pdf-render.mjs";

/** @typedef {{ reportNum: string, reportFile: string, md: string, scratchMd: string, finalDocx: string }} DocxPaths */
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
  const scratchDir = path.join(root, ".career-ops-web", "pdf-tmp");
  fs.mkdirSync(path.join(root, "output"), { recursive: true });
  fs.mkdirSync(scratchDir, { recursive: true });
  const runId = randomBytes(8).toString("hex");
  return {
    ok: true,
    paths: {
      reportNum,
      reportFile: path.relative(root, reportFile).split(path.sep).join("/"),
      md: path.join(root, "output", `${stem}.md`),
      scratchMd: path.join(scratchDir, `cv-web-${reportNum}-${runId}.md`),
      finalDocx: path.join(root, "output", `${stem}.docx`),
    },
  };
}

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

/** Write scratch only — a blocked fact gate must not overwrite a verified companion. @returns {{ok: true}|{ok: false, error: string}} */
export function writeCvMarkdown({ docxPaths, markdown }) {
  const dest = docxPaths.scratchMd ?? docxPaths.md;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, markdown, "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Could not save the tailored CV to ${err.path ?? dest}: ${err.message}` };
  }
}

/** Copy then rename so a half-written companion is never left behind. */
export function promoteScratchMarkdown(scratch, dest, warnings) {
  const tmp = `${dest}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(scratch, tmp);
    fs.renameSync(tmp, dest);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* already gone */ }
    warnings.push(`Word file rendered, but its markdown was not kept: ${err.message}`);
  }
}

/** Remove this run's scratch whether the render succeeded or not. */
export function cleanupDocxScratch(scratch) {
  if (!scratch) return;
  try {
    fs.rmSync(scratch, { force: true });
  } catch (err) {
    console.error(`docx scratch cleanup: could not remove ${scratch}: ${err.message}`);
  }
}

export function spawnGenerateDocx({ spawnFn, execPath, root, md, finalDocx, reportNum, companion }) {
  return new Promise((resolve) => {
    const args = [path.join(root, "generate-docx.mjs"), md, finalDocx, `--report=${reportNum}`];
    if (companion) args.push(`--companion=${companion}`);
    const child = spawnFn(execPath, args, { cwd: root });
    let stderr = "";
    child.stdout?.on?.("data", () => {});
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ ok: code === 0, stderr: stderr.trim() }));
    child.on("error", (e) => resolve({ ok: false, stderr: `Word rendering failed to start: ${e.message}` }));
  });
}

/** @returns {Promise<{kind: "render-failed", error: string}|{kind: "rendered", warnings: string[]}>} */
export async function renderAndMarkDocx({ spawnFn, execPath, root, docxPaths, reportNum }) {
  const warnings = [];
  const scratch = docxPaths.scratchMd;
  try {
    const render = await spawnGenerateDocx({
      spawnFn,
      execPath,
      root,
      md: scratch ?? docxPaths.md,
      finalDocx: docxPaths.finalDocx,
      reportNum,
      companion: docxPaths.md,
    });
    if (!render.ok) {
      return { kind: "render-failed", error: render.stderr || "Word rendering failed." };
    }
    if (scratch) promoteScratchMarkdown(scratch, docxPaths.md, warnings);
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
  } finally {
    cleanupDocxScratch(scratch);
  }
}
