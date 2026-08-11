const TIMEOUT = 20000;
const ROWS = 30;
const TOKENS_PER_CELL = 14;

// Regression test: a line of text dropped at a page break inside a table cell.
//
// Reported against a manual whose "Drill dimensions" cell read
//   Common - eNodeB Name <br /><br /> S1 - PDN Connectivity Reject Cause
// and which printed "Common - eNodeB Name" on one page and "Connectivity Reject
// Cause" on the next, losing the "S1 - PDN" line in between.
//
// Layout.textBreak used to letter-walk a *vertical* overflow looking for the first
// letter at or below the page-content bottom. Every letter on the straddling line
// shares the same top, so none matched and the walk ran on into the *next* line,
// returning that line's offset. The straddling line was therefore left on the
// current page, clipped by the content box's overflow:hidden, while the next page
// resumed after it. Chromium keeps partially clipped glyphs when printing but
// drops fully clipped ones, so once the clip took all of a line's ink that line
// appeared on neither page.
//
// The fixture uses fractional font-size/line-height (the real print-table values)
// so successive line boxes land on non-integer offsets and the page bottom falls
// *inside* a line box rather than neatly between two of them, and gives cells
// enough text to wrap over several lines so the break is routed through textBreak
// instead of landing on a row boundary.
describe("split table cell line break", () => {
	let page;

	beforeAll(async () => {
		page = await loadPage("splits/tables/split-table-cell-line-break.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("splits the table across more than one page (precondition)", async () => {
		let pages = await page.$$eval(".pagedjs_page", (els) => els.length);
		expect(pages).toBeGreaterThan(1);
	});

	it("produces table continuation fragments (precondition)", async () => {
		// Without a split table the fixture would not exercise a mid-cell break and
		// the assertions below would pass trivially.
		let fragments = await page.evaluate(() =>
			Array.from(document.querySelectorAll(".pagedjs_page"))
				.filter((p) => p.querySelector("table[data-split-from], [data-split-from] table"))
				.length);
		expect(fragments).toBeGreaterThan(0);
	});

	it("never leaves a line of text below the page content box", async () => {
		// The invariant the fix establishes. A line whose bottom sits past the
		// content box bottom is clipped in the browser and, when the clip removes
		// all of its glyph ink, is dropped outright by the PDF renderer. Measured
		// per word so a failure names exactly what would be lost.
		let clipped = await page.evaluate(() => {
			const out = [];
			Array.from(document.querySelectorAll(".pagedjs_page")).forEach((pageEl, pageIndex) => {
				const contentEl = pageEl.querySelector(".pagedjs_page_content");
				if (!contentEl) return;
				const boxBottom = contentEl.getBoundingClientRect().bottom;
				const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);
				let node;
				while ((node = walker.nextNode())) {
					const text = node.textContent;
					if (!text.trim()) continue;
					const re = /\S+/g;
					let match;
					while ((match = re.exec(text))) {
						const range = document.createRange();
						range.setStart(node, match.index);
						range.setEnd(node, match.index + match[0].length);
						const rect = range.getBoundingClientRect();
						if (rect.height > 0 && rect.bottom > boxBottom + 0.5) {
							out.push({
								pageIndex,
								word: match[0],
								overflowBy: Math.round((rect.bottom - boxBottom) * 10) / 10
							});
						}
					}
				}
			});
			return out;
		});

		expect(clipped).toEqual([]);
	});

	it("keeps every token in the rendered output", async () => {
		// Complements the geometric check: nothing may go missing from the DOM
		// either (a break token that skipped past content would show up here).
		// Passed as an object and read with dot notation on purpose: babel-jest
		// rewrites a destructured parameter into a _slicedToArray helper, which does
		// not exist inside the page where this callback is evaluated.
		let missing = await page.evaluate((cfg) => {
			const rendered = document.querySelector(".pagedjs_pages").innerText;
			const expected = [];
			for (let r = 1; r <= cfg.rows; r++) {
				expected.push("HEAD-" + r);
				for (let k = 1; k <= cfg.tokensPerCell; k++) expected.push("F" + r + "x" + k);
				for (let k = 1; k <= cfg.tokensPerCell; k++) expected.push("D" + r + "x" + k);
			}
			return expected.filter((token) =>
				!new RegExp("(^|\\s)" + token + "($|\\s)").test(rendered));
		}, { rows: ROWS, tokensPerCell: TOKENS_PER_CELL });

		expect(missing).toEqual([]);
	});
});
