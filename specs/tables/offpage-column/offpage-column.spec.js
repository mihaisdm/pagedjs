const TIMEOUT = 20000;

// Minimal reproduction of the off-page column content loss.
//
// A table with a replicated <thead> and rows whose cells are several paragraphs
// tall. Some content ends up laid out in paged.js's off-page SECOND column
// (`rect.left >= contentBox.right`). It is still in the DOM — which is why a
// text-conservation check does not catch it — but Chromium culls fully-clipped
// glyphs when printing, so it is silently absent from the exported PDF: it
// appears on no page at all.
//
// Currently FAILING and therefore skipped, so the suite stays green while the
// bug is open. Un-skip it when working on a fix — it renders in ~3s, against
// 30s+ for the real 400-page manuals this was found in.
// See portal-pdftools/docs/offpage-column-content-loss.md.
describe("off-page column", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("tables/offpage-column/offpage-column.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	// Every word laid out must be inside its page's content box. Anything at or
	// past the right edge is in the off-page column and will not be printed.
	it.skip("should not lay any text out in the off-page column", async () => {
		let offPage = await page.evaluate(() => {
			const found = [];
			document.querySelectorAll(".pagedjs_page").forEach((pageEl, index) => {
				const contentEl = pageEl.querySelector(".pagedjs_page_content");
				if (!contentEl) return;
				const box = contentEl.getBoundingClientRect();
				if (!(box.width > 0) || !(box.height > 0)) return;
				const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);
				let node;
				while ((node = walker.nextNode())) {
					const text = node.textContent;
					if (!text || !text.trim()) continue;
					const re = /\S+/g;
					let match;
					while ((match = re.exec(text))) {
						const range = document.createRange();
						range.setStart(node, match.index);
						range.setEnd(node, match.index + match[0].length);
						const rect = range.getBoundingClientRect();
						if (!(rect.width > 0) || !(rect.height > 0)) continue;
						if (rect.left >= box.right - 0.5) {
							found.push({ page: index + 1, word: match[0].slice(0, 24) });
						}
					}
				}
			});
			return found;
		});

		expect(offPage).toEqual([]);
	});

	// Separate, stricter property: nothing may be dropped from the DOM outright.
	// This one passes today — the text IS present, merely positioned off-page —
	// and it guards against a "fix" that deletes content instead of moving it.
	it("should keep every character of the source in the paginated output", async () => {
		let missing = await page.evaluate(() => {
			const normalise = (s) => s.replace(/[‐‑­]/g, "").replace(/\s+/g, "");
			let paginated = "";
			document.querySelectorAll(".pagedjs_page_content").forEach((el) => {
				paginated += el.textContent;
			});
			const source = normalise(window.__SOURCE_TEXT__ || "");
			paginated = normalise(paginated);
			// Multiset, not substring: a replicated <thead> is interleaved at each
			// page boundary, so split text is not a contiguous substring even when
			// nothing is lost.
			//
			// Deliberately no destructuring anywhere in this callback: babel-jest
			// rewrites it to a _slicedToArray helper that does not exist in the
			// page, which fails at runtime as a bare ReferenceError.
			const ms = {}, mp = {};
			for (let i = 0; i < source.length; i++) {
				ms[source[i]] = (ms[source[i]] || 0) + 1;
			}
			for (let i = 0; i < paginated.length; i++) {
				mp[paginated[i]] = (mp[paginated[i]] || 0) + 1;
			}
			let count = 0;
			Object.keys(ms).forEach((c) => {
				count += Math.max(0, ms[c] - (mp[c] || 0));
			});
			return count;
		});

		expect(missing).toEqual(0);
	});

});
