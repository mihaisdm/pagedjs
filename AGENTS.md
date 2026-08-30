# AGENTS.md

This file provides guidance to coding agents.

---

## Project overview

Fork of pagedjs 0.4.3 (`origin` = github.com/mihaisdm/pagedjs), working branch
`fix/maxchars-no-progress-v043`. Upstream conventions apply: **tabs**, double quotes,
**LF line endings** (`.editorconfig`), `npm run lint` must stay clean.

The fork's changes are concentrated in table splitting and page-break selection — replicating `<thead>` on
continuation fragments, pinning split-table column widths, orphan control, and several content-loss fixes in
the chunker.

## Build

```bash
npm run build            # or: npx rollup -c --silent
```

Outputs `dist/paged.js` (plain build, no auto-init), `dist/paged.esm.js`, `dist/paged.polyfill.js` (defines
`window.PagedPolyfill` and self-starts on DOMContentLoaded), plus minified variants. `npm run pretest`
(= `build` + `compile`) is what the test images run.

Builds are byte-deterministic for a given Node version, so `md5sum dist/paged.js` is a reliable way to
identify which commit a distributed copy came from — but **keep the Node version fixed when comparing
builds**, or the hash moves for reasons unrelated to your change. This fork has been built with Node 16.

## Tests

CI (`.gitlab-ci.yml`) runs `npm test` and `npm run specs` in Docker. Locally the container is the reliable
path, because the specs need a working Playwright/Chromium and (for the PDF specs) ghostscript:

```bash
docker build -t pagedmedia/pagedjs:test .
docker run --rm --ipc=host -e CI=true pagedmedia/pagedjs:test \
  bash -lc "npm run pretest >/dev/null 2>&1 && npx jest --config=specs/jest.config.js --runInBand <spec>"
```

- **`-e CI=true` is required** so Playwright launches with `--no-sandbox` (it runs as root in the image);
  without it rendering hangs.
- The `docker-specs` npm script bind-mounts `specs/`. If your container runtime cannot resolve host paths
  for mounts (e.g. a Windows container CLI driving a Linux host FS), drop the mount — src and specs are
  already baked in via `COPY .` — and **rebuild the image after every src/spec change**. `.dockerignore`
  excludes `node_modules`/`dist`/`lib`/`.git` and the `npm install` layers cache on `package.json`, so only
  the final `COPY .` re-runs and rebuilds are fast.
- Browser `console.warn`/`console.log` is forwarded to jest output (see `specs/jest_helpers/`), which is by
  far the easiest way to instrument layout code.
- Prefer `--runInBand`. The full parallel suite has intermittently timed out on heavy PDF/large-document
  specs (`__PRINT_READY__`, 30s) under CPU contention — different specs each run, i.e. environmental rather
  than a regression. Always establish a baseline (stash the change, rebuild, run) before blaming a change
  for a suite failure.
- `specs/splits/tables/split-table-column-widths.jest.config.js` is the pattern for running a single spec
  without the PDF/ghostscript setup.

**Known pre-existing failure:** `specs/tables/rebuild/rebuild.spec.js` fails at exactly
`4.275238083448868%` / 82889 differing pixels on an unmodified tree. If you see that number it is not your
change — and because it is bit-stable, any *other* number means you did affect it.

Never bulk `-u` snapshots; review each diff.

## Layout mechanics worth knowing before touching `src/chunker/layout.js`

**The page area is a CSS multi-column container.** `.pagedjs_page_content` gets
`column-width: <page width>; column-gap: <very large>; column-fill: auto` (`src/polisher/base.js`). This is
deliberate: vertical overflow becomes **horizontal** overflow into an off-page second column, which the
chunker detects with `left >= end`. Representative A4 numbers: content box `left 311, right 976`
(width 665), `column-gap 1128.5`, so column 2 spans x 2104→2770.

- `bounds` is captured **once in the Layout constructor, before content is added**, so it describes the
  first (visible) column. The wrapper passed to `findOverflow` grows to span *all* columns as content
  overflows — its rect right was 2770 while `bounds.right` was 976. Don't confuse the two.
- `end = round(bounds.right + gap)` (e.g. 2037) lands inside the gutter, so anything that has flowed into
  column 2 is past it.
- An element or text node spanning two columns returns a **union** rect from `getBoundingClientRect` — top
  from the column-2 fragment, left from column 1 — which makes such nodes look like they start at the page
  top. Use `getClientRects()` (one rect per line/fragment) when you need the truth.
- Content left in the off-page column is invisible in the output but still in the DOM. `findOffPageSplitCandidate`
  / `normalizeOffPageSplitContent` exist for this, but only cover `[data-split-from]`
  table/img/svg/canvas in the fallback-break-token path.

**Order of operations, and the trap in it:** `findOverflow` → `createBreakToken` → `removeOverflow`
(extract). The extraction can change the layout of what remains — for `table-layout: auto` it re-sizes the
columns — which invalidates the measurement the break was computed from. See "column freeze" below.

`findBreakToken` now re-validates after extracting (`rebreakOffPageAfterExtraction`): if the reflow left
text in the off-page column it breaks again, before that box, up to `MAX_OFFPAGE_REBREAKS` times. Each
pass moves the break strictly earlier, so it terminates; a break that would rewind past the token the page
started from is reported as `off-page-after-extraction` instead of looped.

**A finished page must never be restyled — it cannot be repaired.** Removing a marker that caused a
reflow does *not* restore the layout: Chromium's column distribution does not come back, so a page
mutated after it was measured stays wrong. This is why `data-split-to` is applied by
`Layout.markContinuedFragments` while the page is still being laid out, and re-measured before the
overflow is removed, rather than by `Splits.afterPageLayout` while laying out the *next* page. Marking a
finished page was silently losing content: on a Material for MkDocs manual it moved a list into the
off-page column, where it printed on neither page. `Splits.afterPageLayout` still owns `data-split-original`
and alignment, and now matches on the marker instead of applying it. **Anything else that depends on
"this fragment continues overleaf" belongs in the same place, for the same reason.**

**`textBreak`** returns an offset inside a text node. Horizontal overflow (`right > end`) walks letters to
find the exact column that crosses. Vertical overflow breaks at the straddling **word's start**, because a
line cannot be split across the page bottom and the whole line must move down. Note `letters()` iterates to
the end of the **text node**, not the end of the word — that is what made the old
`right > end || bottom > vEnd` branch skip an entire line: every letter on a line shares the same `top`, so
no letter satisfied `top >= vEnd` and the walk ran on into the *next* line, returning its offset. The
straddling line then stayed on the page, clipped, while the next page resumed after it.

**Offset 0 from `textBreak` is meaningful** ("nothing of this node fits") and must not be conflated with
"no break found" — hence `typeof offset === "undefined"` rather than `!offset` in `findOverflow`.

**Hooks.** `Handler`'s constructor (`src/modules/handler.js`) auto-registers any method whose name matches
a hook declared on the chunker or polisher, so adding e.g. `onOverflow(...)` / `afterOverflowRemoved(...)`
to a handler is all that is needed — no wiring. `onOverflow` is called via `triggerSync` and **replaces the
overflow range with any non-undefined return value**, so return nothing unless you mean it.
`beforeOverflow` is declared in the Layout constructor but **never triggered** (dead code), and is absent
from the chunker's hook list, so using it requires adding both the declaration and the trigger.

## Fork-specific code map

`src/modules/paged-media/splits.js`

- `captureSplitTableGeometry` (from `afterPageLayout`) measures the rendered fragment's first body row and
  stashes the widths on the **source** node (`SPLIT_TABLE_COL_WIDTHS`) for continuation fragments. It runs
  ***after*** overflow removal (`chunker.js:395`), so it observes post-extraction widths — do not rely on it
  to preserve pre-break geometry.
- `pinningWouldStrandRow` — refuses to pin a table containing a row taller than the page content area.
  Pinning such a table lays that row's on-page fragment out at full page height at `top:0`, overlapping the
  rows above it, so its short leading cells render nowhere and are silently dropped. Probes an off-screen
  clone because the source table is not laid out. **Do not add a colgroup, inline widths, or header-cell
  widths in the skip path — every such variant reintroduces the misposition.**
- **Column freeze** (`onOverflow` + `afterOverflowRemoved` + `freezeTableColumns`): measures column widths
  *before* extraction and re-applies them *after*, so extraction cannot re-size an auto-layout table and
  reflow an earlier row. Applying after extraction is deliberate — mutating the table before
  `removeOverflow` risks corrupting the overflow `Range` if a boundary container is the `<table>` itself.
  Gated by the same rowspan / colspan / column-count / tall-row checks, evaluated against the **source**
  table.
- `rebuildSplitTable` (`src/utils/dom.js`) replicates `<thead>` and adds the pinned `<colgroup>` on
  continuations. The table width must be the **sum of the captured column widths**, not the bounding-rect
  width (which measured 1831px while the content was 377px).
- Gates for the colgroup width fix: skip when the reference row has `colspan > 1` (ambiguous mapping) or the
  table has any `rowspan > 1` cell. Header replication is independent of those gates (a clone is always
  safe).

`src/chunker/layout.js`

- `isReplicatedTableDecoration` — the injected header/colgroup carry no `data-ref` and crash
  `createBreakToken` if chosen as a break point; scoped to `[data-split-table-colgroup]` /
  `[data-split-table-header]` so native colgroups are untouched.
- `orphanTableForNode` — pushes a whole table to the next page rather than stranding its header or a sliver
  of rows. Handles both element- and text-level overflow nodes.
- `createBreakToken` descends to the **deepest last descendant** when deciding whether a container is fully
  rendered; checking only the immediate last child emits a token past unrendered content and drops whole
  subsections.
- `MAX_CHARS_PER_BREAK` and the no-progress recovery paths (`logUnableToLayout` reasons:
  `max-chars-no-progress`, `forced-break-no-progress`, `end-of-content-no-progress`) exist because a
  repeated break token used to throw `OverflowContentError` and abort the entire render.

## Debugging rendered output

**Pagination is font-metric and binary sensitive.** The same document can paginate differently across
Chromium builds, and Playwright's headless `chromium` may launch `chrome-headless-shell` rather than full
Chrome. When reproducing a pagination-dependent bug, pin the exact binary your target environment uses —
otherwise the page count differs and the case under investigation may not even occur.

**Chromium keeps partially-clipped glyphs when printing but culls fully-clipped ones.** Content that is in
the DOM but entirely outside the page content box is therefore silently absent from the PDF. Two
consequences:

- DOM `innerText` conservation checks **cannot** detect this class of bug. Assert **geometrically**: no text
  rect below `.pagedjs_page_content`'s bottom, none at `left >= box.right`.
- When inspecting a PDF, `page.get_texttrace()` (PyMuPDF) reports every text-showing operation even under a
  clip, which distinguishes "clipped" from "genuinely absent".

**Comparing two PDFs for content loss** — do not diff raw word multisets. `word-break: break-word` splits
words with no hyphen glyph, so the same text appears as `Accessibilit`+`y` in one build and
`Access`+`ibility` in another, faking dozens of "losses". Normalise first: strip running headers/footers by
y-position, remove hyphenation glyphs (U+2010/U+2011/U+00AD), strip all whitespace, then compare lengths and
sample substrings. Residual per-token deltas of 1–2 are usually junction artifacts where body text abuts a
replicated `<thead>` at a different row — confirm by locating the phrase and checking it occurs on the same
pages with the same surrounding context.

## Writing fixtures for these bugs

- **Fractional metrics are required** to reproduce line straddling. Real-world print tables use values like
  `font-size: 8.6pt; line-height: 1.12`, which put line boxes on non-integer offsets so the page bottom
  falls *inside* a line box. With integer metrics the boundary lands between lines and the bug cannot occur
  — which is why most pre-existing fixtures never exercised these paths.
- Cells need enough text to wrap over several lines, or the break lands on a row boundary and `textBreak` is
  never reached at all.
- **Do not set `table-layout: fixed`** in a fixture meant to exercise auto-width drift — that excludes the
  regime by construction.
- The auto-width drift resisted synthetic reproduction (a 112-config sweep over rows × padding × tail width
  produced none): it needs an *earlier* row sitting exactly at a wrap boundary so a ~2px column change adds
  a line. `split-table-column-freeze.spec.js` therefore tests the freeze's **contract** (the fragment ends
  up pinned), not the symptom. Know the difference when relying on it.
- The tall-row fixture asserts the pinning guard still refuses to pin and that the oversized row's leading
  cells survive. It passes with and without the freeze, so it is a guard-regression test, not a
  fix-regression test.

## Environment gotchas

- **An IDE (`.idea/` is present) has silently rewritten `src/chunker/layout.js` to CRLF mid-session**,
  turning a 60-line diff into a whole-file rewrite. Check with `git show HEAD:<file> | grep -c $'\r'`
  against the working copy and fix with `sed -i 's/\r$//' <file>` before diffing or committing.
  `.editorconfig` mandates LF.
- In a spec, **never destructure a `page.evaluate` callback parameter** (`([a, b]) => …`) — babel-jest
  rewrites it to a `_slicedToArray` helper that does not exist inside the page, giving a `ReferenceError` at
  runtime. Pass an object and use dot notation.
- `page.waitForFunction(fn, arg, options)` — passing options as the second argument silently applies the
  default 30s timeout instead.
