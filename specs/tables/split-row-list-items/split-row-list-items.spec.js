const TIMEOUT = 20000;

// Real-world symptom (eoSearch Common Layout Reference Manual, "eoDR Formats"
// table, PDF pages 7-8): a row's Activities cell holds a <ul> of <li> items.
// Five items fit on the page the row starts on; the remaining four belong on the
// continuation page. What printed there was five BARE, textless bullet points
// ahead of those four items -- one bullet per already-shown <li>.
//
// dropLeadingText zeroes the text already shown, then strips now-empty leading
// children to avoid a blank line before the continuation's first word -- but it
// only looked at the cell's own direct children. The cell's only direct child is
// the <ul>, which is NOT itself empty (the last four <li>s still hold text), so
// the pass never descended into it and the five emptied <li>s stayed in the DOM,
// each still rendering its bullet marker with nothing beside it.
describe("a row breaking inside a <ul> cell", () => {
	let page;
	beforeAll(async () => {
		page = await loadPage("tables/split-row-list-items/split-row-list-items.html");
		return page.rendered;
	}, TIMEOUT);

	afterAll(async () => {
		if (!DEBUG) {
			await page.close();
		}
	});

	const renderedCells = () => page.evaluate(() => {
		const out = {};
		const pages = document.querySelectorAll(".pagedjs_page");
		for (let i = 0; i < pages.length; i++) {
			const cells = pages[i].querySelectorAll("[data-cell]");
			for (let j = 0; j < cells.length; j++) {
				const key = cells[j].getAttribute("data-cell");
				if (!out[key]) { out[key] = []; }
				out[key].push({
					page: i + 1,
					text: cells[j].textContent.replace(/\s+/g, " ").trim(),
					liCount: cells[j].querySelectorAll("li").length,
					emptyLiCount: Array.from(cells[j].querySelectorAll("li"))
						.filter((li) => !li.textContent.replace(/\s+/g, "").length).length,
				});
			}
		}
		return out;
	});

	it("splits the list across two pages", async () => {
		const cells = await renderedCells();
		const activities = cells["split-activities"] || [];

		expect(activities.length).toBeGreaterThan(1);
		expect(activities[0].text.length).toBeGreaterThan(0);
		expect(activities[1].text.length).toBeGreaterThan(0);
	});

	// The reported defect: bare bullet points with no text, standing in for the
	// <li>s already shown on the previous page.
	it("leaves no empty <li> on the continuation fragment", async () => {
		const cells = await renderedCells();
		const activities = cells["split-activities"] || [];

		const withEmptyLis = activities.filter((f) => f.emptyLiCount > 0);
		expect(withEmptyLis).toEqual([]);
	});

	// A bare <li> is a bullet with nothing beside it, not missing text -- so a
	// text-only conservation check would not catch it. Counting <li> ELEMENTS
	// (not their text) across every fragment closes that gap: nine source <li>s
	// must render as nine <li>s in total, not nine-plus-some-empties.
	it("renders exactly as many <li> elements as the source, in total", async () => {
		const cells = await renderedCells();
		const activities = cells["split-activities"] || [];
		const sourceLiCount = 9;

		const totalLis = activities.reduce((sum, f) => sum + f.liCount, 0);
		expect(totalLis).toBe(sourceLiCount);
	});

	it("renders each <li> exactly once over the fragments", async () => {
		const cells = await renderedCells();
		const source = await page.evaluate(() => window.__SOURCE_CELLS__);
		const activities = cells["split-activities"] || [];

		const joined = activities
			.map((f) => f.text)
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
		expect(joined.replace(/\s/g, "")).toBe(source["split-activities"].replace(/\s/g, ""));
	});

	it("keeps every character of the source in the paginated output", async () => {
		const missing = await page.evaluate(() => {
			const normalise = (s) => s.replace(/[‐‑­]/g, "").replace(/\s+/g, "");
			let paginated = "";
			const boxes = document.querySelectorAll(".pagedjs_page_content");
			for (let i = 0; i < boxes.length; i++) { paginated += boxes[i].textContent; }
			const source = normalise(window.__SOURCE_TEXT__ || "");
			paginated = normalise(paginated);
			const ms = {}, mp = {};
			for (let i = 0; i < source.length; i++) { ms[source[i]] = (ms[source[i]] || 0) + 1; }
			for (let i = 0; i < paginated.length; i++) { mp[paginated[i]] = (mp[paginated[i]] || 0) + 1; }
			let count = 0;
			Object.keys(ms).forEach((c) => { count += Math.max(0, ms[c] - (mp[c] || 0)); });
			return count;
		});

		expect(missing).toEqual(0);
	});
});
