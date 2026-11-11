import { test } from "node:test";
import assert from "node:assert/strict";
import "../helpers/web-ts-alias-loader.mjs";

const { issueBody } = await import("../../src/lib/report/report.ts");

test("issueBody counts PDFs and Word files as CVs", () => {
  const body = issueBody(
    {
      version: "1",
      coreVersion: "",
      channel: "stable",
      sha: "",
      route: "/",
      cli: "",
      ua: "",
      viewport: "1x1",
      logs: [],
      shape: { data: { reports: 3, pdfs: 2, docxs: 4 } },
      followupsAvailable: true,
    },
    "x",
  );
  assert.match(body, /\*\*CVs:\*\* 6/);
  assert.doesNotMatch(body, /\*\*PDFs:\*\*/);
});
