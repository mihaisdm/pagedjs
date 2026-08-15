const TIMEOUT = 20000;

// A split table's continuation fragments used to drop the source table's own
// <colgroup>, because the fragment is built from a shallow clone. Under
// `table-layout: fixed` a table with no colgroup divides its width EQUALLY between
// the columns, so every continuation fell back to equal columns while the first
// fragment kept the authored proportions.
//
// The user-visible signature is distinctive and is what identified this: only the
// FIRST page of the table looked different -- pages 2..n all agreed with each other,
// because the equal-width fallback is deterministic. Reported on eoSearch Common
// Layout (p7 -> p8, 3 columns: 104/275/285 then 221/221/221) and eoLive Dataviews
// Catalog (p15 -> p16, 6 columns: 71/181/127/97/133/55 then 111 x6).
describe("a split table whose source has its own colgroup", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("tables/split-table-native-colgroup/split-table-native-colgroup.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	// No destructuring in these callbacks: babel-jest rewrites it to a helper that
	// does not exist in the page, and it fails there as a bare ReferenceError.
	const fragments = () => page.evaluate(() => {
		const out = [];
		const pages = document.querySelectorAll(".pagedjs_page");
		for (let i = 0; i < pages.length; i++) {
			const table = pages[i].querySelector("table");
			if (!table) { continue; }
			let widths = [];
			const bodyRows = table.querySelectorAll("tbody > tr");
			for (let r = 0; r < bodyRows.length; r++) {
				if (bodyRows[r].children.length > widths.length) {
					widths = Array.prototype.map.call(bodyRows[r].children,
						(c) => Math.round(c.getBoundingClientRect().width));
				}
			}
			out.push({
				page: i + 1,
				isContinuation: table.hasAttribute("data-split-from"),
				hasColgroup: !!table.querySelector("colgroup"),
				widths: widths,
			});
		}
		return out;
	});

	it("splits the table across several pages (precondition)", async () => {
		const found = await fragments();
		expect(found.length).toBeGreaterThan(2);
		expect(found.some((f) => f.isContinuation)).toBe(true);
	});

	it("gives every continuation fragment a colgroup", async () => {
		const without = (await fragments()).filter((f) => !f.hasColgroup);
		expect(without).toEqual([]);
	});

	// The defect itself. Comparing against the FIRST fragment specifically, because
	// the continuations always agreed with each other even when broken -- an
	// "all fragments equal to each other" check would have passed on the bug.
	it("keeps the first fragment's column proportions on every continuation", async () => {
		const found = await fragments();
		const reference = found[0].widths;

		const misaligned = found
			.map((f) => ({
				page: f.page,
				widths: f.widths,
				maxDelta: Math.max(...f.widths.map((w, i) => Math.abs(w - (reference[i] === undefined ? w : reference[i]))))
			}))
			.filter((f) => f.maxDelta > 2);

		expect(misaligned).toEqual([]);
	});

	// Guards the specific broken state: equal-width columns are what fixed layout
	// falls back to with no colgroup, and the authored proportions are not equal.
	it("does not fall back to equal-width columns", async () => {
		const found = await fragments();
		const equalWidth = found.filter((f) => {
			if (f.widths.length < 2) { return false; }
			return f.widths.every((w) => Math.abs(w - f.widths[0]) <= 2);
		});
		expect(equalWidth).toEqual([]);
	});

	it("keeps every character of the source in the paginated output", async () => {
		const missing = await page.evaluate(() => {
			const normalise = (s) => s.replace(/[‐‑­]/g, "").replace(/\s+/g, "");
			let paginated = "";
			const boxes = document.querySelectorAll(".pagedjs_page_content");
			for (let i = 0; i < boxes.length; i++) { paginated += boxes[i].textContent; }
			const source = normalise(window.__SOURCE_TEXT__ || "");
			paginated = normalise(paginated);
			// Multiset: the replicated <thead> is interleaved at each page boundary.
			const ms = {}, mp = {};
			for (let i = 0; i < source.length; i++) { ms[source[i]] = (ms[source[i]] || 0) + 1; }
			for (let i = 0; i < paginated.length; i++) { mp[paginated[i]] = (mp[paginated[i]] || 0) + 1; }
			let count = 0;
			Object.keys(ms).forEach((c) => { count += Math.max(0, ms[c] - (mp[c] || 0)); });
			return count;
		});

		expect(missing).toEqual(0);
	});

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
