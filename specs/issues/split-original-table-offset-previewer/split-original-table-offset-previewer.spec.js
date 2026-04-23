const TIMEOUT = 120000;

describe("split-original table offset previewer export", () => {
	let page;

	beforeAll(async () => {
		page = await loadPage("issues/split-original-table-offset-previewer/split-original-table-offset-previewer.html");
		await page.waitForFunction(() => window.__PRINT_READY__ === true, { timeout: TIMEOUT });
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("should keep split-original table fragments within the visible page box", async () => {
		const result = await page.evaluate(() => {
			const pagedPages = Array.from(document.querySelectorAll(".pagedjs_page"));
			const splitOriginalTables = Array.from(document.querySelectorAll('table[data-split-original="true"]'));
			const targetImage = Array.from(document.querySelectorAll(".pagedjs_page img"))
				.find((img) => img.alt.includes("TreePopUp"));
			const matchingTables = splitOriginalTables.filter((table) => {
				const text = table.innerText;
				return text.includes("DataViewID") || text.includes("ProfileName");
			});

			const misplacedFragments = splitOriginalTables
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
						text: table.innerText.slice(0, 120)
					};
				})
				.filter(Boolean)
				.filter((entry) => entry.leftWithinPage > 200);

			let misplacedImageFragment = null;
			if (targetImage) {
				const page = targetImage.closest(".pagedjs_page");
				if (page instanceof HTMLElement) {
					const pageRect = page.getBoundingClientRect();
					const imageRect = targetImage.getBoundingClientRect();

					misplacedImageFragment = {
						pageIndex: pagedPages.indexOf(page),
						leftWithinPage: Math.round(imageRect.left - pageRect.left),
						rightWithinPage: Math.round(imageRect.right - pageRect.left),
						width: Math.round(imageRect.width),
						alt: targetImage.alt.slice(0, 120)
					};
				}
			}

			return {
				layoutWarnings: window.__LAYOUT_WARNINGS__ || [],
				misplacedImageFragment,
				splitOriginalCount: splitOriginalTables.length,
				targetTableCount: matchingTables.length,
				misplacedFragments,
			};
		});

		expect(result.layoutWarnings).toEqual([]);
		if (result.misplacedImageFragment) {
			expect(result.misplacedImageFragment.leftWithinPage).toBeLessThanOrEqual(200);
		}
		expect(result.splitOriginalCount).toBeGreaterThan(0);
		expect(result.targetTableCount).toBeGreaterThanOrEqual(2);
		expect(result.misplacedFragments).toEqual([]);
	});
});
