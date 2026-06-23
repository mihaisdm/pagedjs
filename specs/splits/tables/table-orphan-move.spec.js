const TIMEOUT = 10000;

// Per page that carries (part of) the table, report: the page index, how many
// table rows (header + body) the fragment renders, whether the fragment is a
// split continuation, and whether the page has non-table content above the
// table. This is enough to describe the orphan we are guarding against.
function collectTablePages(page) {
	return page.evaluate(() => {
		const pages = Array.from(document.querySelectorAll(".pagedjs_page"));
		const report = [];
		pages.forEach((pageEl, pageIndex) => {
			const table = pageEl.querySelector("table");
			if (!table) {
				return;
			}
			const rowCount = table.querySelectorAll("tr").length;
			const lead = pageEl.querySelector(".lead");
			report.push({
				pageIndex,
				rowCount,
				isContinuation: table.hasAttribute("data-split-from"),
				hasContentAboveTable: !!lead
			});
		});
		return report;
	});
}

describe("table near a page bottom is moved instead of orphaned", () => {
	let page;

	beforeAll(async () => {
		page = await loadPage("splits/tables/table-orphan-move.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("still splits the table across more than one page (precondition)", async () => {
		const tablePages = await collectTablePages(page);
		expect(tablePages.length).toBeGreaterThan(1);
	});

	it("does not strand the table on the page that already holds the lead content", async () => {
		// The motivating bug: the table starts at the bottom of the page that
		// carries the lead block, rendering only its header there and then
		// repeating that header on the following continuation page. Orphan
		// control must move the whole table off that page instead.
		const leadPageHasTable = await page.evaluate(() => {
			const leadPage = Array.from(document.querySelectorAll(".pagedjs_page"))
				.find((pageEl) => pageEl.querySelector(".lead"));
			return !!(leadPage && leadPage.querySelector("table"));
		});
		expect(leadPageHasTable).toBe(false);
	});

	it("starts the table with more than 3 rows on its first fragment", async () => {
		const tablePages = await collectTablePages(page);

		// The first fragment of the table is the one that is not a continuation.
		const firstFragment = tablePages.find((entry) => !entry.isContinuation);
		expect(firstFragment).toBeDefined();

		// Asserted unconditionally: after orphan control the table begins on a
		// page with room for a healthy number of rows, never just the header
		// (or a one/two-row sliver) at the foot of the previous page.
		expect(firstFragment.rowCount).toBeGreaterThan(3);
	});

	it("renders the table header on a single starting fragment (no duplicated start)", async () => {
		const tablePages = await collectTablePages(page);
		const startingFragments = tablePages.filter((entry) => !entry.isContinuation);
		// Exactly one fragment owns the original (non-continuation) header; the
		// orphaned header-only fragment that used to precede the continuation is
		// gone.
		expect(startingFragments).toHaveLength(1);
	});
});
