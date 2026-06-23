const TIMEOUT = 10000;

// Regression test for orphan control when the page-bottom sliver is shorter
// than the table's header. A wide, fixed-layout table that starts there has too
// little room even for its header, so the header overflows *inside* its cells
// (the overflow node is a <th> descendant). Orphan control that only triggers
// on a structural, non-cell overflow misses this and strands the table on the
// page that already holds the lead content — its header renders degenerately
// and splits across the page boundary. The whole table must move to the next
// page instead.
function collectTablePages(page) {
	return page.evaluate(() => {
		return Array.from(document.querySelectorAll(".pagedjs_page"))
			.map((pageEl, pageIndex) => {
				const table = pageEl.querySelector("table");
				if (!table) return null;
				return {
					pageIndex,
					rowCount: table.querySelectorAll("tr").length,
					bodyRows: table.querySelectorAll("tbody > tr").length,
					isContinuation: table.hasAttribute("data-split-from"),
				};
			})
			.filter(Boolean);
	});
}

describe("wide table whose header overflows a page-bottom sliver is moved", () => {
	let page;

	beforeAll(async () => {
		page = await loadPage("splits/tables/table-orphan-header-overflow.html");
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
		const leadPageHasTable = await page.evaluate(() => {
			const leadPage = Array.from(document.querySelectorAll(".pagedjs_page"))
				.find((pageEl) => pageEl.querySelector(".lead"));
			return !!(leadPage && leadPage.querySelector("table"));
		});
		expect(leadPageHasTable).toBe(false);
	});

	it("starts the table with body rows on its first fragment (not header-only)", async () => {
		const tablePages = await collectTablePages(page);
		const firstFragment = tablePages.find((entry) => !entry.isContinuation);
		expect(firstFragment).toBeDefined();
		expect(firstFragment.bodyRows).toBeGreaterThan(0);
	});
});
