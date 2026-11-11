# templates/docx/garamond

Static Word parts for `generate-docx.mjs`. The generator writes only
`word/document.xml` (and the package plumbing) and zips these parts with it.

Layout values come from the reference resume the template was modelled on:

| Property | Value |
|---|---|
| Page | Letter, portrait |
| Margins | left/right 720, top 630, bottom 414, footer 342 (twips) |
| Font | Garamond, 12 pt body, 11 pt for skills lines |
| Line spacing | 252/240 (1.05) |
| Name | centred, 18 pt bold, 0.75 pt bottom rule |
| Section heading | UPPERCASE, bold, 0.75 pt bottom rule |
| Bullets | `▪` in Arial (so the glyph survives if Garamond is missing), left 360 twips, hanging 360 |
| Dates | italic, right-aligned tab at the text width (10800 twips) |

The numeric values the generator reads live in `lib/docx-resume.mjs`
(`LAYOUT`); the parts here must agree with them. `tests/docx-resume.test.mjs`
checks both.

Fonts are named, never embedded. There is no embedding flag. Word on Mac and
Windows ships Garamond; a machine or viewer without it (LibreOffice, some ATS
previews, Google Docs import) substitutes another serif, and line breaks or
the page count may shift. The `▪` bullet is explicitly Arial in
`word/numbering.xml` so the glyph still appears after that substitution.

Output-root policy is local to `generate-docx.mjs`: writes are allowed under
the project directory, the data root (`CAREER_OPS_ROOT`), or `os.tmpdir()`.
That check is case-insensitive on macOS and Windows. It is not shared with
`generate-pdf.mjs`.

Only the theme (`word/theme/theme1.xml`) is copied verbatim from the
reference. The reference's styles and numbering carried duplicate definitions
and embedded font references, so those parts are rewritten here.
