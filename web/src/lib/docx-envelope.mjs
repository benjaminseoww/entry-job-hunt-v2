/**
 * docx-envelope.mjs — the docx-mode agent's output channel.
 *
 * Same contract as cv-envelope.mjs: the agent emits the tailored markdown
 * inline and the backend persists it, so the worker needs no write tool.
 * Word is US Letter only, so there is no format attribute.
 */
export const OPEN_MARK = "<<cv-md";
export const CLOSE_MARK = "<</cv-md>>";

const OPENER_SRC = String.raw`^<<cv-md>>[ \t]*$`;
const CLOSER_SRC = String.raw`^<<\/cv-md>>[ \t]*$`;
const OPENER = new RegExp(OPENER_SRC, "gm");
const CLOSER = new RegExp(CLOSER_SRC, "m");
const CLOSER_ALL = new RegExp(CLOSER_SRC, "gm");

export const DOCX_ENVELOPE_INSTRUCTION =
  `Do NOT save or edit any file — the platform persists your output for you. Instead OUTPUT the finished tailored markdown inline, between two marker lines. The first line contains only the opening marker \`${OPEN_MARK}>>\` and nothing else on that line. Then the complete markdown document (the same section order as cv.md), then a final line containing only \`${CLOSE_MARK}\`. Each marker appears exactly once. Emit the WHOLE document — never abbreviate, summarize, or write "unchanged"; the platform renders exactly these bytes and nothing else.`;

/**
 * @typedef {Object} DocxEnvelope
 * @property {true} ok
 * @property {string} markdown
 * @property {string[]} warnings
 */

/**
 * @param {string} text
 * @returns {DocxEnvelope | {ok: false, error: string}}
 */
export function parseDocxEnvelope(text) {
  if (typeof text !== "string") {
    return { ok: false, error: "No agent output to read a CV envelope from." };
  }
  const normalized = text.replace(/\r\n/g, "\n");

  const openers = [...normalized.matchAll(OPENER)];
  if (openers.length === 0) {
    return { ok: false, error: "The agent emitted no <<cv-md>> envelope, so there is no CV to render." };
  }
  if (openers.length > 1) {
    return { ok: false, error: `Found ${openers.length} <<cv-md>> envelopes; refusing to guess which is the real CV.` };
  }

  const opener = openers[0];
  const afterOpener = normalized.slice(opener.index + opener[0].length);
  const closer = CLOSER.exec(afterOpener);
  if (!closer) {
    return { ok: false, error: "The <<cv-md>> envelope was never closed — the CV output is incomplete." };
  }

  const markdown = afterOpener.slice(0, closer.index).replace(/^\n/, "").replace(/\n$/, "");
  if (!markdown.trim()) {
    return { ok: false, error: "The <<cv-md>> envelope was empty — no CV was tailored." };
  }
  if (!/^#\s+\S/m.test(markdown)) {
    return { ok: false, error: "The tailored markdown has no heading — the output is incomplete." };
  }

  return { ok: true, markdown, warnings: [] };
}

function couldBecomeMarker(line) {
  return (
    OPEN_MARK.startsWith(line) || CLOSE_MARK.startsWith(line) ||
    line.startsWith(OPEN_MARK) || line.startsWith(CLOSE_MARK)
  );
}

function completeMarker(re, s) {
  for (const m of s.matchAll(re)) {
    const after = m.index + m[0].length;
    if (s[after] === "\n") return { start: m.index, end: after + 1 };
  }
  return null;
}

export function createDocxEnvelopeFilter() {
  let raw = "";
  let pending = "";
  let carry = "";
  let inBody = false;

  return {
    push(chunk) {
      const text = String(chunk ?? "");
      raw += text;
      const withCarry = carry + text;
      carry = withCarry.endsWith("\r") ? "\r" : "";
      pending += (carry ? withCarry.slice(0, -1) : withCarry).replace(/\r\n/g, "\n");
      let display = "";
      for (;;) {
        if (!inBody) {
          const opener = completeMarker(OPENER, pending);
          if (opener) {
            display += pending.slice(0, opener.start);
            pending = pending.slice(opener.end);
            inBody = true;
            continue;
          }
          const tailStart = pending.lastIndexOf("\n") + 1;
          const cut = couldBecomeMarker(pending.slice(tailStart)) ? tailStart : pending.length;
          display += pending.slice(0, cut);
          pending = pending.slice(cut);
          return display;
        }
        const closer = completeMarker(CLOSER_ALL, pending);
        if (closer) {
          pending = pending.slice(closer.end);
          inBody = false;
          continue;
        }
        const tailStart = pending.lastIndexOf("\n") + 1;
        pending = pending.slice(tailStart);
        return display;
      }
    },

    flush() {
      const held = inBody ? "" : pending + carry;
      pending = "";
      carry = "";
      return held;
    },

    result() {
      return parseDocxEnvelope(raw);
    },
  };
}
