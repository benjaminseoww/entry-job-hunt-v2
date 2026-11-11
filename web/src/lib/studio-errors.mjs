/**
 * CV Studio save/rewrite errors shown to the user. Codes stay on the wire;
 * this map (and `message` when the API sends one) is what the UI prints.
 */
export const STALE = "This CV was regenerated in another tab. Reload the Studio.";
export const WORD_CV_SAVE_ERROR = "CV Studio does not edit Word CVs yet";

export const SAVE_ERRORS = {
  stale: STALE,
  busy: "This CV is already being saved. Wait for that save to finish.",
  "word-cv": WORD_CV_SAVE_ERROR,
};

/**
 * @param {{ error?: string, message?: string } | null | undefined} body
 * @param {string} fallback
 */
export function studioErrorMessage(body, fallback) {
  return SAVE_ERRORS[body?.error ?? ""] ?? body?.message ?? body?.error ?? fallback;
}
