import Layout from "./layout.js";

// A break point is a single position in document order, so a break taken inside
// a table cell carries the rest of that cell *and every following cell of the
// row* onto the next page. The row's columns end up staggered across the
// boundary: on the first page the later columns are blank, on the second the
// earlier ones are. Observed on eoLive Dataviews p83/p84, row "S1 - PDN
// Connectivity Failure Rate" — columns 3 to 6 empty on p83, present on p84.
//
// paged.js answers this by moving the whole row to the next page when a cell
// declares `break-inside: avoid`. That only helps when there is somewhere with
// more room to move to.
describe("Layout.rowCanMoveToNextPage", () => {

	const canMove = (row) => Layout.prototype.rowCanMoveToNextPage.call(null, row);

	// jsdom parses the markup the way a browser does, inserting the implied
	// tbody — which is what the predicate keys off.
	const table = (html) => {
		const host = document.createElement("div");
		host.innerHTML = `<table>${html}</table>`;
		return host.querySelector("table");
	};

	const HEAD = "<thead><tr><th>Name</th><th>Description</th></tr></thead>";

	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("moves a row that an earlier body row precedes on the page", () => {
		const t = table(`${HEAD}<tbody>
			<tr><td>first</td><td>row</td></tr>
			<tr id="overflowing"><td>tall</td><td>cell</td></tr>
		</tbody>`);

		expect(canMove(t.querySelector("#overflowing"))).toBe(true);
	});

	// The row is the only one on the page and still overflows it, so it is taller
	// than the space a whole page offers. Pushing it would name the same row
	// again; the chunker would see the break token repeat and stop, leaving the
	// rest of the document unrendered. It has to split in place instead.
	it("does not move the first body row", () => {
		const t = table(`${HEAD}<tbody>
			<tr id="overflowing"><td>tall</td><td>cell</td></tr>
			<tr><td>later</td><td>row</td></tr>
		</tbody>`);

		expect(canMove(t.querySelector("#overflowing"))).toBe(false);
	});

	// This is the case a position-based test gets wrong. A continuation page
	// carries a replicated header, so the first row on it starts well below the
	// top of the content box and measures as "began partway down the page" — but
	// there is still nothing before it to make room.
	it("does not treat a preceding header row as room to move into", () => {
		const t = table(`${HEAD}<tbody>
			<tr id="overflowing"><td>tall</td><td>cell</td></tr>
		</tbody>`);

		expect(canMove(t.querySelector("#overflowing"))).toBe(false);
	});

	// A header cell overflowing must not drag its row anywhere: the header is
	// replicated decoration on continuation pages and moving it makes no progress.
	it("never moves a header row", () => {
		const t = table(`${HEAD}<tbody><tr><td>body</td><td>row</td></tr></tbody>`);

		expect(canMove(t.querySelector("thead tr"))).toBe(false);
	});

	// An empty leading row is what a split leaves behind; it is not the content
	// that would free up space, so it must not count.
	it("ignores preceding rows with no rendered text", () => {
		const t = table(`${HEAD}<tbody>
			<tr><td></td><td>   </td></tr>
			<tr id="overflowing"><td>tall</td><td>cell</td></tr>
		</tbody>`);

		expect(canMove(t.querySelector("#overflowing"))).toBe(false);
	});

	// Rows that FOLLOW the overflowing one are on the next page already and say
	// nothing about room on this one.
	it("ignores following rows", () => {
		const t = table(`${HEAD}<tbody>
			<tr id="overflowing"><td>tall</td><td>cell</td></tr>
			<tr><td>plenty</td><td>of text here</td></tr>
			<tr><td>and</td><td>more</td></tr>
		</tbody>`);

		expect(canMove(t.querySelector("#overflowing"))).toBe(false);
	});

	// Confluence exports occasionally group rows into more than one tbody.
	it("counts a body row from an earlier tbody", () => {
		const t = table(`${HEAD}
			<tbody><tr><td>first</td><td>group</td></tr></tbody>
			<tbody><tr id="overflowing"><td>tall</td><td>cell</td></tr></tbody>`);

		expect(canMove(t.querySelector("#overflowing"))).toBe(true);
	});

	// `insideTableCell.parentElement` is a TR for well-formed markup, but the
	// caller passes it through unchecked.
	it("refuses anything that is not a table row", () => {
		const t = table("<tbody><tr><td>body</td></tr></tbody>");

		expect(canMove(t.querySelector("tbody"))).toBe(false);
		expect(canMove(null)).toBe(false);
		expect(canMove(undefined)).toBe(false);
	});

	// A row outside any table cannot be reasoned about.
	it("refuses a detached row", () => {
		const orphan = document.createElement("tr");
		Object.defineProperty(orphan, "nodeName", { value: "TR" });

		expect(canMove(orphan)).toBe(false);
	});
});
