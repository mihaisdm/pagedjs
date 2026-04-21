const TIMEOUT = 120000;

describe("split-original table offset full export", () => {
	let page;

	beforeAll(async () => {
		page = await loadPage("issues/split-original-table-offset-full/split-original-table-offset-full.html");
		await page.waitForFunction(() => document.querySelectorAll(".pagedjs_page").length > 0, { timeout: TIMEOUT });
		let previous = -1;
		let stableIterations = 0;

		for (let attempt = 0; attempt < 120; attempt += 1) {
			const current = await page.evaluate(() => document.querySelectorAll(".pagedjs_page").length);

			if (current > 0 && current === previous) {
				stableIterations += 1;
				if (stableIterations >= 4) {
					return;
				}
			} else {
				stableIterations = 0;
				previous = current;
			}

			await page.waitForTimeout(1000);
		}

		throw new Error("paged output did not stabilize");
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
