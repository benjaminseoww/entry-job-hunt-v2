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
| Bullets | `▪`, left 360 twips, hanging 360 |
| Dates | italic, right-aligned tab at the text width (10800 twips) |

The numeric values the generator reads live in `lib/docx-resume.mjs`
(`LAYOUT`); the parts here must agree with them. `tests/docx-resume.test.mjs`
checks both.

Fonts are named, not embedded. Word on Mac and Windows ships Garamond; a
machine without it substitutes a serif and line breaks may move.

Only the theme (`word/theme/theme1.xml`) is copied verbatim from the
reference. The reference's styles and numbering carried duplicate definitions
and embedded font references, so those parts are rewritten here.
