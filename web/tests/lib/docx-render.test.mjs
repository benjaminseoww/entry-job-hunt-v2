import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  docxRunOutcome,
  writeCvMarkdown,
  spawnGenerateDocx,
  renderAndMarkDocx,
  resolveDocxPaths,
} from "../../src/lib/docx-render.mjs";

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

test("writeCvMarkdown: persists the tailored markdown", () => {
  const root = mkdtempSync(join(tmpdir(), "co-docx-write-"));
  try {
    const md = join(root, "output", "cv.md");
    const written = writeCvMarkdown({ docxPaths: { md }, markdown: "# Jane Doe\n" });
    assert.equal(written.ok, true);
    assert.equal(readFileSync(md, "utf8"), "# Jane Doe\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("spawnGenerateDocx: invokes generate-docx.mjs with --report", async () => {
  const calls = [];
  const spawnFn = (execPath, args, opts) => {
    calls.push({ execPath, args, opts });
    return fakeChild({ exitCode: 0 });
  };
  const result = await spawnGenerateDocx({
    spawnFn,
    execPath: "node",
    root: "/root",
    md: "/root/output/cv.md",
    finalDocx: "/root/output/cv.docx",
    reportNum: "018",
  });
  assert.deepEqual(result, { ok: true, stderr: "" });
  assert.match(calls[0].args[0], /generate-docx\.mjs$/);
  assert.deepEqual(calls[0].args.slice(1), ["/root/output/cv.md", "/root/output/cv.docx", "--report=018"]);
});

test("renderAndMarkDocx: stub worker writes Word then marks the tracker", async () => {
  const { spawnFn, calls } = makeRouterSpawn({
    "generate-docx.mjs": { exitCode: 0 },
    "mark-pdf-ready.mjs": { exitCode: 0, stdout: JSON.stringify({ ok: true }) },
  });
  const root = mkdtempSync(join(tmpdir(), "co-docx-render-"));
  try {
    const result = await renderAndMarkDocx({
      spawnFn,
      execPath: "node",
      root,
      docxPaths: { md: join(root, "cv.md"), finalDocx: join(root, "cv.docx") },
      reportNum: "018",
    });
    assert.equal(result.kind, "rendered");
    assert.equal(calls.length, 2);
    assert.match(calls[0].args[0], /generate-docx\.mjs$/);
    assert.match(calls[1].args[0], /mark-pdf-ready\.mjs$/);
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
    const result = resolveDocxPaths("018", "2026-01-10", root, (n) => join(root, "reports", `018-acme-2026-01-10.md`));
    assert.equal(result.ok, true);
    assert.match(result.paths.md, /output\/cv-candidate-018-acme-2026-01-10\.md$/);
    assert.match(result.paths.finalDocx, /output\/cv-candidate-018-acme-2026-01-10\.docx$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
