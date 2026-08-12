const TIMEOUT = 20000;

// A page break inside a table cell used to carry the rest of that cell AND every
// later cell of the row onto the next page, because a break token is a single
// position in document order and the cells of a row are siblings in it. The row's
// columns then read staggered across the boundary: blank on one page, and the
// earlier columns blank on the other. Reported on the eoLive Dataviews Catalog,
// p83/p84 of a 399-page export.
//
// The cells of a row should instead break the way the row does: each shows what
// fits above the cut and continues below it.
describe("a row breaking inside a cell", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("tables/split-row-columns/split-row-columns.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	// data-cell -> the text rendered for it, per page, in page order.
	//
	// No destructuring anywhere in these callbacks: babel-jest rewrites it to a
	// _slicedToArray helper that does not exist in the page, and it fails there as
	// a bare ReferenceError.
	const renderedCells = () => page.evaluate(() => {
		const out = {};
		const pages = document.querySelectorAll(".pagedjs_page");
		for (let i = 0; i < pages.length; i++) {
			const cells = pages[i].querySelectorAll("[data-cell]");
			for (let j = 0; j < cells.length; j++) {
				const key = cells[j].getAttribute("data-cell");
				if (!out[key]) { out[key] = []; }
				out[key].push({
					page: i + 1,
					text: cells[j].textContent.replace(/\s+/g, " ").trim(),
				});
			}
		}
		return out;
	});

	it("splits the row across two pages", async () => {
		const cells = await renderedCells();
		const desc = cells["split-desc"] || [];

		expect(desc.length).toBeGreaterThan(1);
		expect(desc[0].text.length).toBeGreaterThan(0);
		expect(desc[1].text.length).toBeGreaterThan(0);
	});

	// The reported defect: the columns after the broken one were blank on the page
	// the row started on, and only appeared on the next.
	it("shows the columns after the broken one on the page the row starts on", async () => {
		const cells = await renderedCells();
		const firstPage = (cells["split-desc"] || [{ page: 0 }])[0].page;

		["split-formula", "split-filter", "split-label"].forEach((key) => {
			const onFirst = (cells[key] || []).filter((f) => f.page === firstPage);
			expect(onFirst.length).toBe(1);
			expect(onFirst[0].text).not.toBe("");
		});
	});

	// A <td> stretches to the height of its ROW, so a short cell in a tall row
	// reports an overflow its text does not have. Measuring the box rather than the
	// text emptied every short cell of a splitting row, which is what the reporter
	// saw next: columns 3, 4 and 6 blank while 2 and 5 split correctly.
	it("keeps short cells whole rather than emptying them", async () => {
		const cells = await renderedCells();
		const source = await page.evaluate(() => window.__SOURCE_CELLS__);

		["split-formula", "split-filter", "split-label"].forEach((key) => {
			const withText = (cells[key] || []).filter((f) => f.text !== "");
			expect(withText.length).toBe(1);
			expect(withText[0].text).toBe(source[key]);
		});
	});

	// A later column too tall for the space left must break like the broken column
	// does, not jump the page as a unit.
	it("splits a later column that does not fit, instead of moving it whole", async () => {
		const cells = await renderedCells();
		const dims = (cells["split-dims"] || []).filter((f) => f.text !== "");

		expect(dims.length).toBeGreaterThan(1);
	});

	// The property that matters most, and the only one that survives the reordering
	// this feature introduces: every cell's fragments, joined in page order, must
	// reproduce its source text exactly. Short of it means content was dropped;
	// longer means it printed twice.
	it("renders each cell exactly once over its fragments", async () => {
		const cells = await renderedCells();
		const source = await page.evaluate(() => window.__SOURCE_CELLS__);

		const wrong = [];
		Object.keys(source).forEach((key) => {
			const joined = (cells[key] || [])
				.map((f) => f.text)
				.join(" ")
				.replace(/\s+/g, " ")
				.trim();
			const want = source[key];
			// Compare with all whitespace removed: a fragment boundary can fall
			// inside a word, so rejoining with a space is not character-exact.
			if (joined.replace(/\s/g, "") !== want.replace(/\s/g, "")) {
				wrong.push({ cell: key, want: want.slice(0, 60), got: joined.slice(0, 60) });
			}
		});

		expect(wrong).toEqual([]);
	});

	it("keeps every character of the source in the paginated output", async () => {
		const missing = await page.evaluate(() => {
			const normalise = (s) => s.replace(/[‐‑­]/g, "").replace(/\s+/g, "");
			let paginated = "";
			const boxes = document.querySelectorAll(".pagedjs_page_content");
			for (let i = 0; i < boxes.length; i++) { paginated += boxes[i].textContent; }
			const source = normalise(window.__SOURCE_TEXT__ || "");
			paginated = normalise(paginated);
			// Multiset, not substring: a replicated <thead> is interleaved at each
			// page boundary and the row's columns are reordered, so nothing about
			// the paginated text is contiguous even when nothing is lost.
			const ms = {}, mp = {};
			for (let i = 0; i < source.length; i++) { ms[source[i]] = (ms[source[i]] || 0) + 1; }
			for (let i = 0; i < paginated.length; i++) { mp[paginated[i]] = (mp[paginated[i]] || 0) + 1; }
			let count = 0;
			Object.keys(ms).forEach((c) => { count += Math.max(0, ms[c] - (mp[c] || 0)); });
			return count;
		});

		expect(missing).toEqual(0);
	});

	// Nothing may be laid out into paged.js's off-page second column: it is still in
	// the DOM, so the checks above cannot see it, but Chromium culls fully-clipped
	// glyphs when printing and it is absent from the PDF.
	it("lays no text out in the off-page column", async () => {
		const offPage = await page.evaluate(() => {
			const found = [];
			const pages = document.querySelectorAll(".pagedjs_page");
			for (let i = 0; i < pages.length; i++) {
				const contentEl = pages[i].querySelector(".pagedjs_page_content");
				if (!contentEl) { continue; }
				const box = contentEl.getBoundingClientRect();
				if (!(box.width > 0) || !(box.height > 0)) { continue; }
				const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);
				let node;
				while ((node = walker.nextNode())) {
					if (!node.textContent || !node.textContent.trim()) { continue; }
					const re = /\S+/g;
					let match;
					while ((match = re.exec(node.textContent))) {
						const range = document.createRange();
						range.setStart(node, match.index);
						range.setEnd(node, match.index + match[0].length);
						const rect = range.getBoundingClientRect();
						if (!(rect.width > 0) || !(rect.height > 0)) { continue; }
						if (rect.left >= box.right - 0.5) {
							found.push("p" + (i + 1) + " " + match[0].slice(0, 24));
						}
					}
				}
			}
			return found;
		});

		expect(offPage).toEqual([]);
	});
});
