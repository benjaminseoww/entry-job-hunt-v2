import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  docxRunOutcome,
  writeCvMarkdown,
  spawnGenerateDocx,
  renderAndMarkDocx,
  resolveDocxPaths,
} from "../../src/lib/docx-render.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HONEST_CV = readFileSync(join(REPO, "examples", "cv-example.md"), "utf8");
const INFLATED_CV = HONEST_CV
  .replaceAll("99.7%", "99.99%")
  .replaceAll("$2M", "$40M")
  .replaceAll("3 engineers", "30 engineers");

function fakeChild({ stdout = "", stderr = "", exitCode = 0, spawnError = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => {
    if (spawnError) {
      child.emit("error", spawnError);
      return;
    }
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", exitCode);
  });
  return child;
}

function makeRouterSpawn(routes) {
  const calls = [];
  const spawnFn = (execPath, args, opts) => {
    calls.push({ execPath, args, opts });
    const scriptPath = args[0];
    const route = Object.entries(routes).find(([suffix]) => scriptPath.endsWith(suffix));
    if (!route) throw new Error(`no fake route for ${scriptPath}`);
    return fakeChild(route[1]);
  };
  return { spawnFn, calls };
}

test("docxRunOutcome: a clean envelope with paths is ok", () => {
  assert.deepEqual(
    docxRunOutcome({
      envelope: { ok: true, markdown: "# Jane" },
      noOutputMessage: null,
      sawError: false,
      cleanExit: true,
      hasPaths: true,
    }),
    { ok: true },
  );
});

test("docxRunOutcome: a missing envelope fails closed", () => {
  const result = docxRunOutcome({
    envelope: { ok: false, error: "The agent emitted no <<cv-md>> envelope, so there is no CV to render." },
    noOutputMessage: null,
    sawError: false,
    cleanExit: true,
    hasPaths: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /no <<cv-md>> envelope/);
});

test("writeCvMarkdown: persists the tailored markdown to scratch, not the companion", () => {
  const root = mkdtempSync(join(tmpdir(), "co-docx-write-"));
  try {
    const md = join(root, "output", "cv.md");
    const scratchMd = join(root, ".career-ops-web", "pdf-tmp", "cv-web-001-abc.md");
    const written = writeCvMarkdown({ docxPaths: { md, scratchMd }, markdown: "# Jane Doe\n" });
    assert.equal(written.ok, true);
    assert.equal(readFileSync(scratchMd, "utf8"), "# Jane Doe\n");
    assert.equal(existsSync(md), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeCvMarkdown: scratchMd is required", () => {
  const written = writeCvMarkdown({ docxPaths: { md: "/tmp/cv.md" }, markdown: "# Jane Doe\n" });
  assert.equal(written.ok, false);
  assert.match(written.error, /scratchMd is required/);
});

test("renderAndMarkDocx: scratchMd is required", async () => {
  const result = await renderAndMarkDocx({
    spawnFn: () => { throw new Error("must not spawn"); },
    execPath: "node",
    root: "/tmp",
    docxPaths: { md: "/tmp/cv.md", finalDocx: "/tmp/cv.docx" },
    reportNum: "018",
  });
  assert.equal(result.kind, "render-failed");
  assert.match(result.error, /scratchMd is required/);
});

test("spawnGenerateDocx: invokes generate-docx.mjs with --report and --companion", async () => {
  const calls = [];
  const spawnFn = (execPath, args, opts) => {
    calls.push({ execPath, args, opts });
    return fakeChild({ exitCode: 0 });
  };
  const result = await spawnGenerateDocx({
    spawnFn,
    execPath: "node",
    root: "/root",
    md: "/root/.career-ops-web/pdf-tmp/cv-web-018-run.md",
    finalDocx: "/root/output/cv.docx",
    reportNum: "018",
    companion: "/root/output/cv.md",
  });
  assert.deepEqual(result, { ok: true, stderr: "" });
  assert.match(calls[0].args[0], /generate-docx\.mjs$/);
  assert.deepEqual(calls[0].args.slice(1), [
    "/root/.career-ops-web/pdf-tmp/cv-web-018-run.md",
    "/root/output/cv.docx",
    "--report=018",
    "--companion=/root/output/cv.md",
  ]);
});

test("renderAndMarkDocx: stub worker writes Word then marks the tracker", async () => {
  const { spawnFn, calls } = makeRouterSpawn({
    "generate-docx.mjs": { exitCode: 0 },
    "mark-pdf-ready.mjs": { exitCode: 0, stdout: JSON.stringify({ ok: true }) },
  });
  const root = mkdtempSync(join(tmpdir(), "co-docx-render-"));
  try {
    const md = join(root, "output", "cv.md");
    const scratchMd = join(root, "scratch.md");
    mkdirSync(join(root, "output"), { recursive: true });
    writeFileSync(scratchMd, "# promoted\n");
    const result = await renderAndMarkDocx({
      spawnFn,
      execPath: "node",
      root,
      docxPaths: { md, scratchMd, finalDocx: join(root, "output", "cv.docx") },
      reportNum: "018",
    });
    assert.equal(result.kind, "rendered");
    assert.equal(readFileSync(md, "utf8"), "# promoted\n");
    assert.equal(existsSync(scratchMd), false);
    assert.equal(calls.length, 2);
    assert.match(calls[0].args[0], /generate-docx\.mjs$/);
    assert.equal(calls[0].args.includes("--companion=" + md), true);
    assert.match(calls[1].args[0], /mark-pdf-ready.mjs$/);
    assert.equal(calls[1].args[1], "018");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveDocxPaths: names md and docx under output/", () => {
  const root = mkdtempSync(join(tmpdir(), "co-docx-paths-"));
  try {
    mkdirSync(join(root, "reports"), { recursive: true });
    writeFileSync(join(root, "reports", "018-acme-2026-01-10.md"), "# Acme\n");
    const result = resolveDocxPaths("018", "2026-01-10", root, () => join(root, "reports", `018-acme-2026-01-10.md`));
    assert.equal(result.ok, true);
    assert.equal(result.paths.md, join(root, "output", "cv-candidate-018-acme-2026-01-10.md"));
    assert.equal(result.paths.finalDocx, join(root, "output", "cv-candidate-018-acme-2026-01-10.docx"));
    assert.equal(dirname(result.paths.scratchMd), join(root, ".career-ops-web", "pdf-tmp"));
    assert.match(result.paths.scratchMd.replaceAll("\\", "/"), /cv-web-018-[0-9a-f]{16}\.md$/);
    const again = resolveDocxPaths("018", "2026-01-10", root, () => join(root, "reports", `018-acme-2026-01-10.md`));
    assert.notEqual(again.paths.scratchMd, result.paths.scratchMd);
    assert.equal(again.paths.md, result.paths.md);
    assert.equal(again.paths.finalDocx, result.paths.finalDocx);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renderAndMarkDocx: a failed stub run leaves the companion .md untouched and deletes scratch", async () => {
  const { spawnFn } = makeRouterSpawn({
    "generate-docx.mjs": { exitCode: 1, stderr: "Fact check failed" },
  });
  const root = mkdtempSync(join(tmpdir(), "co-docx-fail-"));
  try {
    const md = join(root, "output", "cv.md");
    const scratchMd = join(root, ".career-ops-web", "pdf-tmp", "cv-web-018-run.md");
    mkdirSync(join(root, "output"), { recursive: true });
    mkdirSync(join(root, ".career-ops-web", "pdf-tmp"), { recursive: true });
    writeFileSync(md, "# honest\n");
    writeFileSync(scratchMd, "# inflated\n");
    const result = await renderAndMarkDocx({
      spawnFn,
      execPath: "node",
      root,
      docxPaths: { md, scratchMd, finalDocx: join(root, "output", "cv.docx") },
      reportNum: "018",
    });
    assert.equal(result.kind, "render-failed");
    assert.equal(readFileSync(md, "utf8"), "# honest\n");
    assert.equal(existsSync(scratchMd), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renderAndMarkDocx: a failed stub run with no prior .md leaves none in output/", async () => {
  const { spawnFn } = makeRouterSpawn({
    "generate-docx.mjs": { exitCode: 1, stderr: "Fact check failed" },
  });
  const root = mkdtempSync(join(tmpdir(), "co-docx-orphan-"));
  try {
    const md = join(root, "output", "cv.md");
    const scratchMd = join(root, ".career-ops-web", "pdf-tmp", "cv-web-018-run.md");
    mkdirSync(join(root, "output"), { recursive: true });
    mkdirSync(join(root, ".career-ops-web", "pdf-tmp"), { recursive: true });
    writeFileSync(scratchMd, "# inflated\n");
    const result = await renderAndMarkDocx({
      spawnFn,
      execPath: "node",
      root,
      docxPaths: { md, scratchMd, finalDocx: join(root, "output", "cv.docx") },
      reportNum: "018",
    });
    assert.equal(result.kind, "render-failed");
    assert.equal(existsSync(md), false);
    assert.deepEqual(readdirSync(join(root, "output")).filter((f) => f.endsWith(".md")), []);
    assert.equal(existsSync(scratchMd), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function withDocxFixture(fn) {
  const dataRoot = mkdtempSync(join(tmpdir(), "co-docx-e2e-"));
  const prevProfile = process.env.CAREER_OPS_PROFILE;
  mkdirSync(join(dataRoot, "data"), { recursive: true });
  mkdirSync(join(dataRoot, "output"), { recursive: true });
  mkdirSync(join(dataRoot, "reports"), { recursive: true });
  mkdirSync(join(dataRoot, "config"), { recursive: true });
  writeFileSync(join(dataRoot, "cv.md"), HONEST_CV);
  writeFileSync(join(dataRoot, "config", "profile.yml"), "candidate:\n  full_name: Alex Chen\n");
  writeFileSync(join(dataRoot, "reports", "001-acme-2026-11-11.md"), "# Acme\n");
  writeFileSync(
    join(dataRoot, "data", "applications.md"),
    `# Applications Tracker

| # | Date | Company | Role | Score | Status | Word | Report | Notes |
|---|------|---------|------|-------|--------|------|--------|-------|
| 1 | 2026-11-11 | Acme | Engineer | 4.2/5 | Evaluated | ❌ | [1](../reports/001-acme-2026-11-11.md) | — |
`,
  );
  const env = {
    ...process.env,
    CAREER_OPS_ROOT: dataRoot,
    CAREER_OPS_DATA_DIR: dataRoot,
  };
  delete env.CAREER_OPS_TRACKER;
  delete env.CAREER_OPS_PDF_INDEX;
  delete env.CAREER_OPS_PROFILE;
  delete process.env.CAREER_OPS_PROFILE;
  const spawnFn = (execPath, args, opts) => spawn(execPath, args, { ...opts, env });
  try {
    return await fn({ dataRoot, spawnFn });
  } finally {
    if (prevProfile !== undefined) process.env.CAREER_OPS_PROFILE = prevProfile;
    else delete process.env.CAREER_OPS_PROFILE;
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

function outputMarkdown(dataRoot) {
  return readdirSync(join(dataRoot, "output")).filter((f) => f.endsWith(".md")).sort();
}

test("renderAndMarkDocx e2e: real generate-docx.mjs, | Word | tracker, blocked fact-gate runs", { timeout: 60_000 }, async () => {
  await withDocxFixture(async ({ dataRoot, spawnFn }) => {
    const resolved = resolveDocxPaths("001", "2026-11-11", dataRoot, () => join(dataRoot, "reports", "001-acme-2026-11-11.md"));
    assert.equal(resolved.ok, true);
    const paths = resolved.paths;
    writeCvMarkdown({ docxPaths: paths, markdown: HONEST_CV });

    const honest = await renderAndMarkDocx({
      spawnFn,
      execPath: process.execPath,
      root: REPO,
      docxPaths: paths,
      reportNum: paths.reportNum,
    });
    assert.equal(honest.kind, "rendered", JSON.stringify(honest));
    assert.equal(existsSync(paths.finalDocx), true);
    assert.equal(readFileSync(paths.md, "utf8"), HONEST_CV);
    assert.equal(existsSync(paths.scratchMd), false);

    const index = readFileSync(join(dataRoot, "data", "pdf-index.tsv"), "utf8");
    assert.match(index, /\toutput\/cv-alex-chen-001-acme-2026-11-11\.docx\toutput\/cv-alex-chen-001-acme-2026-11-11\.md\tletter\t\d{4}-\d{2}-\d{2}\tcv/);
    const tracker = readFileSync(join(dataRoot, "data", "applications.md"), "utf8");
    assert.match(tracker, /\| Word \|/);
    assert.match(tracker, /\| 1 \| 2026-11-11 \| Acme \| Engineer \| 4\.2\/5 \| Evaluated \| ✅ \|/);
    const honestDocx = readFileSync(paths.finalDocx);

    const blockedSameDay = resolveDocxPaths("001", "2026-11-11", dataRoot, () => join(dataRoot, "reports", "001-acme-2026-11-11.md"));
    writeCvMarkdown({ docxPaths: blockedSameDay.paths, markdown: INFLATED_CV });
    const blocked = await renderAndMarkDocx({
      spawnFn,
      execPath: process.execPath,
      root: REPO,
      docxPaths: blockedSameDay.paths,
      reportNum: blockedSameDay.paths.reportNum,
    });
    assert.equal(blocked.kind, "render-failed");
    assert.match(blocked.error, /99\.99%|\$40m|30 engineers/i);
    assert.equal(readFileSync(paths.md, "utf8"), HONEST_CV);
    assert.deepEqual(readFileSync(paths.finalDocx), honestDocx);
    assert.equal(existsSync(blockedSameDay.paths.scratchMd), false);
    assert.deepEqual(outputMarkdown(dataRoot), ["cv-alex-chen-001-acme-2026-11-11.md"]);

    const nextDay = resolveDocxPaths("001", "2026-11-12", dataRoot, () => join(dataRoot, "reports", "001-acme-2026-11-11.md"));
    writeCvMarkdown({ docxPaths: nextDay.paths, markdown: INFLATED_CV });
    const orphan = await renderAndMarkDocx({
      spawnFn,
      execPath: process.execPath,
      root: REPO,
      docxPaths: nextDay.paths,
      reportNum: nextDay.paths.reportNum,
    });
    assert.equal(orphan.kind, "render-failed");
    assert.equal(existsSync(nextDay.paths.md), false);
    assert.equal(existsSync(nextDay.paths.finalDocx), false);
    assert.equal(existsSync(nextDay.paths.scratchMd), false);
    assert.deepEqual(outputMarkdown(dataRoot), ["cv-alex-chen-001-acme-2026-11-11.md"]);
    assert.equal(readFileSync(join(dataRoot, "data", "applications.md"), "utf8"), tracker);
  });
});

test("SIGTERM removes the scratch markdown", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "co-docx-sigterm-"));
  const scratchMd = join(root, "scratch.md");
  const readyFile = join(root, "ready");
  const md = join(root, "cv.md");
  const script = join(root, "hang.mjs");
  writeFileSync(script, `import { writeFileSync } from "node:fs";
import { writeCvMarkdown } from ${JSON.stringify(join(REPO, "web/src/lib/docx-render.mjs"))};
const written = writeCvMarkdown({ docxPaths: { md: ${JSON.stringify(md)}, scratchMd: ${JSON.stringify(scratchMd)} }, markdown: "# x\\n" });
if (!written.ok) {
  console.error(written.error);
  process.exit(1);
}
writeFileSync(${JSON.stringify(readyFile)}, "ok");
setInterval(() => {}, 60000);
`);
  const child = spawn(process.execPath, [script], {
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  const killChild = (signal) => {
    try { process.kill(child.pid, signal); } catch { /* already gone */ }
  };
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(readyFile) || !existsSync(scratchMd)) {
      if (Date.now() > deadline) {
        throw new Error(`timeout waiting for scratch: stderr=${JSON.stringify(stderr)}`);
      }
      if (child.exitCode !== null || child.signalCode) {
        throw new Error(`child exited ${child.exitCode} ${child.signalCode} stderr=${JSON.stringify(stderr)}`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    killChild("SIGTERM");
    await new Promise((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
    assert.equal(existsSync(scratchMd), false);
  } finally {
    killChild("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
