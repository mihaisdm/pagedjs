const TIMEOUT = 10000;

// Regression test for the chunker "Layout repeated" abort.
//
// A split table whose per-column widths are captured on page 1 and pinned
// (table-layout:fixed) on continuations can oscillate: a later row needs more
// width than page 1's short rows gave, so under the pinned-narrow column it
// wraps taller and the break point never advances. The chunker used to detect
// the repeated break token and throw OverflowContentError, aborting the whole
// render and dropping every page after the cycle — including all content that
// follows the table. The chunker now skips forward past the offending break
// point and keeps rendering.
describe("split table layout-repeated recovery", () => {
	let page;

	beforeAll(async () => {
		page = await loadPage("splits/tables/split-table-loop.html");
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

	it("keeps rendering the content that follows the cycling table", async () => {
		// Before the fix the chunker threw OverflowContentError and aborted the
		// whole render, so this paragraph — which comes after the table in source
		// order — never reached any page. The fix skips forward past the cycling
		// break point, so layout continues and downstream content is preserved.
		let present = await page.evaluate(() =>
			(document.querySelector(".pagedjs_pages")?.innerText || "").includes("CONTENT_AFTER_TABLE"));
		expect(present).toBe(true);
	});
});
