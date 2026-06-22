const TIMEOUT = 10000;

// Collect, per page fragment of the (single) table, the rendered width of each
// column measured from the first body row, plus whether the fragment carries a
// repeated header.
function collectFragments(page) {
	return page.evaluate(() => {
		const fragments = [];
		const pages = Array.from(document.querySelectorAll(".pagedjs_page"));
		pages.forEach((pageEl, pageIndex) => {
			const table = pageEl.querySelector("table");
			if (!table) {
				return;
			}
			const firstBodyRow = table.querySelector("tbody > tr");
			const colWidths = firstBodyRow
				? Array.from(firstBodyRow.children).map((cell) =>
					Math.round(cell.getBoundingClientRect().width))
				: [];
			const headerCells = table.querySelectorAll("thead th, thead td");
			fragments.push({
				pageIndex,
				colWidths,
				hasHeader: headerCells.length > 0,
				isContinuation: table.hasAttribute("data-split-from")
			});
		});
		return fragments;
	});
}

function maxColumnDelta(colWidths, reference) {
	return Math.max(...colWidths.map((width, index) =>
		Math.abs(width - (reference[index] ?? width))));
}

// Each fixture exercises the same guarantees under a different layout regime:
//  - "content width": container ≈ natural table width (no column stretching).
//  - "wide container": width:100% table in a container far wider than its
//    content, so page 1 auto-layout *stretches* the columns; continuations
//    must reproduce the stretched widths, not the smaller content widths.
const FIXTURES = [
	{ label: "content width", path: "splits/tables/split-table-column-widths.html" },
	{ label: "wide container", path: "splits/tables/split-table-column-widths-wide.html" }
];

FIXTURES.forEach(({ label, path }) => {
	describe(`split table column widths (${label})`, () => {
		let page;

		beforeAll(async () => {
			page = await loadPage(path);
			return page.rendered;
		}, TIMEOUT);

		afterAll(async () => {
			if (!DEBUG) {
				await page.close();
			}
		});

		it("splits the table across more than one page (precondition)", async () => {
			const fragments = await collectFragments(page);
			expect(fragments.length).toBeGreaterThan(1);
		});

		it("keeps column widths aligned across every page fragment", async () => {
			const fragments = await collectFragments(page);
			expect(fragments.length).toBeGreaterThan(1);

			const reference = fragments[0].colWidths;
			const misaligned = fragments
				.map((fragment) => ({
					pageIndex: fragment.pageIndex,
					colWidths: fragment.colWidths,
					reference,
					maxDelta: maxColumnDelta(fragment.colWidths, reference)
				}))
				.filter((fragment) => fragment.maxDelta > 2);

			expect(misaligned).toEqual([]);
		});

		it("repeats the table header on every continuation page", async () => {
			const fragments = await collectFragments(page);
			const continuationsWithoutHeader = fragments
				.filter((fragment) => fragment.isContinuation)
				.filter((fragment) => !fragment.hasHeader)
				.map((fragment) => fragment.pageIndex);

			expect(continuationsWithoutHeader).toEqual([]);
		});
	});
});
