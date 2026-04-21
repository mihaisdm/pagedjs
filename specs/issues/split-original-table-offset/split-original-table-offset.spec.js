const TIMEOUT = 10000;

describe("split-original table offset", () => {
	let page;

	beforeAll(async () => {
		page = await loadPage("issues/split-original-table-offset/split-original-table-offset.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("should keep split-original table fragments within the visible page box", async () => {
		const misplacedFragments = await page.evaluate(() => {
			const pagedPages = Array.from(document.querySelectorAll(".pagedjs_page"));

			return Array.from(document.querySelectorAll('table[data-split-original="true"]'))
				.map((table) => {
					const page = table.closest(".pagedjs_page");
					if (!(page instanceof HTMLElement)) {
						return null;
					}

					const pageRect = page.getBoundingClientRect();
					const tableRect = table.getBoundingClientRect();

					return {
						pageIndex: pagedPages.indexOf(page),
						leftWithinPage: Math.round(tableRect.left - pageRect.left),
						width: Math.round(tableRect.width),
						text: table.innerText.slice(0, 80)
					};
				})
				.filter(Boolean)
				.filter((entry) => entry.leftWithinPage > 200);
		});

		expect(misplacedFragments).toEqual([]);
	});
});
