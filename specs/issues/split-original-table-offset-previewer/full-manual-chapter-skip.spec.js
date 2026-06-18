const TIMEOUT = 180000;

// Faithful reproduction of the PDF chapter-skip bug using the FULL eolive
// manual article extracted from the production build (doc-frontend/build/.../
// eolive/index.html). The minimal single-section fixture does NOT reproduce the
// bug: it requires the cross-chapter layout cascade that only occurs deep in the
// document, where chapter 18's <article> box is pushed past the page boundary so
// findOverflow coarsens the overflow to the <article>, and createBreakToken
// emits a break token at the whitespace BETWEEN the chapter-18 and chapter-19
// <section>s — silently dropping 18.2's tail through 18.7.
//
// IMPORTANT — geometry sensitivity: this reproduction depends on the fixture
// paginating EXACTLY like the production build (full manual content + the
// production bootstrap's classifyTablesForPrint() + production print-preview.css)
// so chapter 18's <article> box lands past the page boundary and findOverflow
// coarsens the overflow to the <article>. If future content/CSS/font changes
// shift pagination, this test could go green WITHOUT exercising the bug. The
// total-page-count canary below flags gross pagination drift; if it trips,
// re-confirm the fixture still reproduces RED against an unfixed paged.js before
// trusting a green run.
//
// Selectors use data-print-number, stable against id churn.
const SUBSECTIONS = [
	{ pn: "18",     label: "18 User profiles and capabilities" },
	{ pn: "18.1",   label: "18.1 User" },
	{ pn: "18.2",   label: "18.2 Expert or power user" },
	{ pn: "18.3",   label: "18.3 Administrator" },
	{ pn: "18.4",   label: "18.4 Enhanced security" },
	{ pn: "18.4.1", label: "18.4.1 Restrict access to Dataview/folders" },
	{ pn: "18.4.2", label: "18.4.2 Restrict access to data sources" },
	{ pn: "18.5",   label: "18.5 Standard MC security capabilities" },
	{ pn: "18.6",   label: "18.6 Edit alarms" },
	{ pn: "18.7",   label: "18.7 Support of portable devices" },
];

describe("eolive full-manual chapter skip (18.3-18.7)", () => {
	let page;

	beforeAll(async () => {
		page = await loadPage(
			"issues/split-original-table-offset-previewer/full-manual-chapter-skip.html"
		);
		await page.waitForFunction(() => window.__PRINT_READY__ === true, { timeout: TIMEOUT });
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	it("paginates close to the production build (canary against geometry drift)", async () => {
		const total = await page.$$eval(".pagedjs_page", (r) => r.length);
		// Production renders ~229 pages with the fix (~226 with the bug). A large
		// deviation means pagination drifted and this fixture may no longer
		// reproduce the original overflow condition — see the header note.
		expect(total).toBeGreaterThan(200);
	});

	for (const { pn, label } of SUBSECTIONS) {
		it(`${label} must be rendered inside a page`, async () => {
			const pageNumber = await page.evaluate((pn) => {
				const el = document.querySelector(
					`.pagedjs_pages [data-print-number="${pn}"]`
				);
				if (!el) return null;
				const pg = el.closest(".pagedjs_page");
				return pg ? pg.dataset.pageNumber : null;
			}, pn);
			expect(pageNumber).not.toBeNull();
		});
	}

	it("chapter 19 (CSV) must exist on a page", async () => {
		const pageNumber = await page.evaluate(() => {
			const el = document.querySelector(`.pagedjs_pages [data-print-number="19"]`);
			if (!el) return null;
			const pg = el.closest(".pagedjs_page");
			return pg ? pg.dataset.pageNumber : null;
		});
		expect(pageNumber).not.toBeNull();
	});

	it("18.7 and chapter 19 must be on different pages, with 19 after 18.7", async () => {
		const [p187, p19] = await page.evaluate(() => {
			const pagesEl = document.querySelector(".pagedjs_pages");
			const el187 = pagesEl.querySelector(`[data-print-number="18.7"]`);
			const el19 = pagesEl.querySelector(`[data-print-number="19"]`);
			return [
				el187 ? Number(el187.closest(".pagedjs_page")?.dataset.pageNumber) : null,
				el19 ? Number(el19.closest(".pagedjs_page")?.dataset.pageNumber) : null,
			];
		});
		expect(p187).not.toBeNull();
		expect(p19).not.toBeNull();
		expect(p19).toBeGreaterThan(p187);
	});
});
