const TIMEOUT = 20000;
const GROUPS = 6;

// Regression test: list items left in the off-page column and never re-rendered.
//
// Reported from a Material for MkDocs manual. On its grids reference page a
// content-tab set holds a three-item <ul> and a three-item <ol>; where a page
// boundary fell inside the block, the tail of one list and the whole of the next
// were laid out in the page area's off-page second column and the following page
// resumed past them. The items stay in the DOM and are absent from the PDF,
// because Chromium culls fully clipped glyphs.
//
// Nothing in the chain is monolithic -- the print stylesheet flattens the
// grid, the tab set, the tab panel and each tab block to plain block flow with
// visible overflow -- so this is not the "box that cannot fragment" case that
// findOffPageSplitCandidate covers. The break simply skips past the content.
//
// Assert geometrically, not by innerText: the content stays in the DOM either way,
// so a conservation check cannot see this class of loss (AGENTS.md).
describe("nested list off-page column", () => {
	let page;

	beforeAll(async () => {
		page = await loadPage("splits/lists/nested-list-off-page-column.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("breaks the content across several pages (precondition)", async () => {
		let pages = await page.$$eval(".pagedjs_page", (els) => els.length);
		expect(pages).toBeGreaterThan(2);
	});

	it("splits at least one list across a page boundary (precondition)", async () => {
		// Without a list actually straddling a boundary the assertion below would
		// pass trivially.
		let split = await page.evaluate(() =>
			document.querySelectorAll(".pagedjs_page [data-split-from]").length);
		expect(split).toBeGreaterThan(0);
	});

	it("never leaves text in the off-page column", async () => {
		// The invariant. The page area is a multi-column container whose second
		// column is off the sheet, so anything at or past the content box's right
		// edge is invisible in the output while still present in the DOM.
		let offPage = await page.evaluate(() => {
			const out = [];
			Array.from(document.querySelectorAll(".pagedjs_page")).forEach((pageEl, pageIndex) => {
				const contentEl = pageEl.querySelector(".pagedjs_page_content");
				if (!contentEl) return;
				const box = contentEl.getBoundingClientRect();
				if (!(box.width > 0)) return;
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
						if (rect.width > 0 && rect.height > 0 && rect.left >= box.right - 0.5) {
							out.push({ pageIndex, word: match[0] });
						}
					}
				}
			});
			return out;
		});

		expect(offPage).toEqual([]);
	});

	it("never leaves text below the page content box", async () => {
		let below = await page.evaluate(() => {
			const out = [];
			Array.from(document.querySelectorAll(".pagedjs_page")).forEach((pageEl, pageIndex) => {
				const contentEl = pageEl.querySelector(".pagedjs_page_content");
				if (!contentEl) return;
				const box = contentEl.getBoundingClientRect();
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
						if (rect.height > 0 && rect.bottom > box.bottom + 0.5 && rect.left < box.right - 0.5) {
							out.push({ pageIndex, word: match[0] });
						}
					}
				}
			});
			return out;
		});

		expect(below).toEqual([]);
	});

	it("renders every list item somewhere inside a page content box", async () => {
		// Complements the geometry: names the item that would be missing. Passed as
		// an object and read with dot notation on purpose -- babel-jest rewrites a
		// destructured parameter into a _slicedToArray helper that does not exist
		// inside the page.
		let missing = await page.evaluate((cfg) => {
			const shown = new Set();
			Array.from(document.querySelectorAll(".pagedjs_page")).forEach((pageEl) => {
				const contentEl = pageEl.querySelector(".pagedjs_page_content");
				if (!contentEl) return;
				const box = contentEl.getBoundingClientRect();
				Array.from(contentEl.querySelectorAll("li")).forEach((li) => {
					const rect = li.getBoundingClientRect();
					if (!(rect.width > 0) || rect.left >= box.right - 0.5) return;
					const token = (li.textContent || "").trim().split(/\s+/)[0];
					if (token) shown.add(token);
				});
			});
			const expected = [];
			for (let g = 1; g <= cfg.groups; g++) {
				for (const p of ["SEDA", "DONA", "NULA", "SEDB", "DONB", "NULB"]) expected.push(p + g);
			}
			return expected.filter((token) => !shown.has(token));
		}, { groups: GROUPS });

		expect(missing).toEqual([]);
	});
});
