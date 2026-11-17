/** Pins: Studio hidden for Word, View uses the just-finished job kind, cv-kind matches fill. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const web = join(dirname(fileURLToPath(import.meta.url)), "../..");
const button = readFileSync(join(web, "src/components/generate-pdf-button.tsx"), "utf8");
const kindRoute = readFileSync(join(web, "src/app/api/cv-kind/route.ts"), "utf8");
const provider = readFileSync(join(web, "src/components/apply/apply-provider.tsx"), "utf8");

test("View tailored CV uses cvIsWord or the just-finished docx job kind", () => {
  assert.match(button, /import \{ isWordCvView \} from "@\/lib\/cv-format\.mjs"/);
  assert.match(button, /isWordCvView\(cvIsWord, job\?\.kind\)/);
  assert.match(button, /\/api\/cv-preview\?/);
});

test("Review and customize is hidden for a Word CV", () => {
  assert.match(button, /\{!wordView && \(/);
  assert.match(button, /Review and customize/);
});

test("cv-kind resolves the same session CV fill attaches, including title", () => {
  assert.match(kindRoute, /import \{ resolveSessionCv \} from "@\/lib\/apply\/cv"/);
  assert.match(kindRoute, /searchParams\.get\("title"\)/);
  assert.match(kindRoute, /resolveSessionCv\(\{[\s\S]*company:[\s\S]*application:[\s\S]*title:/);
});

test("apply provider passes the session title to cv-kind", () => {
  assert.match(provider, /kindQs\.set\("title", qs\.title\)/);
  assert.match(provider, /requestCvFormat\(\{ application: opts\?\.n, company: opts\?\.company, title: d\.title \}\)/);
});
