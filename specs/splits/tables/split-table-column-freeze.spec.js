const TIMEOUT = 30000;

// Regression tests for the column freeze applied around overflow removal.
//
// A table laid out with `table-layout: auto` sizes its columns from its content,
// so removing the overflow re-sizes them: the fragment that stays behind is
// measured, a break is chosen from that measurement, and then extracting the tail
// changes the very widths the measurement was based on. A couple of pixels is
// enough to make an *earlier* row wrap one line further, pushing every row below
// it down. Because page content is laid out as a multi-column container, a line
// pushed past the bottom does not simply clip — it reflows into the next
// (off-page) column, where it is clipped away entirely and dropped from the
// printed output while the next page resumes after it, so it is lost from both
// pages. Reported against an eoLTE manual whose cell read
//   Common - eNodeB Name <br /><br /> S1 - PDN Connectivity Reject Cause
// and which printed neither "S1 - PDN" on the page it belonged to nor on the next.
//
// The columns are therefore measured before the overflow is removed and re-applied
// afterwards, pinning the geometry the break was computed from.
//
// The pinning guard that protects tables with a page-taller row (pinning lays such
// a row's fragment out at full page height and drops its leading cells) must still
// be respected — that is what the second fixture checks.

function pageReport(page) {
	return page.evaluate(() => {
		return Array.from(document.querySelectorAll(".pagedjs_page")).map((pageEl, pageIndex) => {
			const contentEl = pageEl.querySelector(".pagedjs_page_content");
			const box = contentEl ? contentEl.getBoundingClientRect() : null;
			const table = pageEl.querySelector("table");
			const headRow = table && table.querySelector("tr");
			const offPage = [];
			const belowBox = [];

			if (contentEl) {
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
						if (rect.height <= 0) continue;
						// A later column of the multi-column page area: off the page.
						if (rect.left >= box.right - 0.5) offPage.push(match[0]);
						else if (rect.bottom > box.bottom + 0.5) belowBox.push(match[0]);
					}
				}
			}

			return {
				pageIndex,
				hasTable: !!table,
				isContinuation: !!(table && table.hasAttribute("data-split-from")),
				pinned: !!(table && table.querySelector("colgroup[data-split-table-colgroup]")),
				colWidths: headRow
					? Array.from(headRow.children).map((c) => Math.round(c.getBoundingClientRect().width))
					: [],
				offPage,
				belowBox
			};
		});
	});
}

describe("split table column freeze", () => {
	let page;

	beforeAll(async () => {
		page = await loadPage("splits/tables/split-table-column-freeze.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("splits the content-sized table across more than one page (precondition)", async () => {
		const report = (await pageReport(page)).filter((p) => p.hasTable);
		expect(report.length).toBeGreaterThan(1);
		expect(report.some((p) => p.isContinuation)).toBe(true);
	});

	it("pins the fragment whose overflow was removed", async () => {
		// The first fragment is the one that has content extracted from it, so it is
		// the one whose auto column widths could drift afterwards. Before the fix it
		// was left unpinned and was the only fragment that could reflow.
		const report = await pageReport(page);
		const firstFragment = report.find((p) => p.hasTable && !p.isContinuation);
		expect(firstFragment).toBeDefined();
		expect(firstFragment.pinned).toBe(true);
	});

	it("keeps column widths identical across every fragment", async () => {
		const fragments = (await pageReport(page)).filter((p) => p.hasTable && p.colWidths.length);
		const reference = fragments[0].colWidths;
		const misaligned = fragments
			.map((f) => ({
				pageIndex: f.pageIndex,
				colWidths: f.colWidths,
				maxDelta: Math.max(...f.colWidths.map((w, i) => Math.abs(w - (reference[i] ?? w))))
			}))
			.filter((f) => f.maxDelta > 2);
		expect(misaligned).toEqual([]);
	});

	it("never leaves text in an off-page column or below the content box", async () => {
		// The user-visible symptom: such text is clipped away and dropped by the PDF
		// renderer, so it appears on no page at all.
		const stray = (await pageReport(page))
			.filter((p) => p.offPage.length || p.belowBox.length)
			.map((p) => ({ pageIndex: p.pageIndex, offPage: p.offPage, belowBox: p.belowBox }));
		expect(stray).toEqual([]);
	});
});

describe("split table column freeze (table with a page-taller row)", () => {
	let page;

	beforeAll(async () => {
		page = await loadPage("splits/tables/split-table-column-freeze-tall-row.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("splits the table across more than one page (precondition)", async () => {
		const report = (await pageReport(page)).filter((p) => p.hasTable);
		expect(report.length).toBeGreaterThan(1);
	});

	it("leaves such a table unpinned, honouring the pinning guard", async () => {
		// Pinning a table whose row is taller than the page lays that row's on-page
		// fragment out at full page height, overlapping the rows above it, so its
		// short leading cells render nowhere. The freeze must not reintroduce that.
		const pinned = (await pageReport(page)).filter((p) => p.pinned).map((p) => p.pageIndex);
		expect(pinned).toEqual([]);
	});

	it("keeps the leading cells of the page-taller row", async () => {
		// The dropped-cell symptom pinning causes: the id columns of the oversized
		// row disappear while the rest of the row is still rendered.
		const rendered = await page.evaluate(() =>
			document.querySelector(".pagedjs_pages").innerText);
		expect(rendered).toContain("G4");
		expect(rendered).toContain("A4");
		expect(rendered).toContain("MO-4");
	});

	it("keeps every word of the oversized cell", async () => {
		const missing = await page.evaluate(() => {
			const rendered = document.querySelector(".pagedjs_pages").innerText;
			const absent = [];
			for (let k = 1; k <= 1400; k++) {
				const token = "t4w" + k;
				if (!new RegExp("(^|\\s)" + token + "($|\\s)").test(rendered)) absent.push(token);
			}
			return absent;
		});
		expect(missing).toEqual([]);
	});
});
