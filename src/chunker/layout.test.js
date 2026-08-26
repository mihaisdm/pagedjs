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

// A break token names where the *next* page resumes, so it must always sit
// after the token the current page started from. One that does not means the
// overflow was resolved against a node that stands for content already
// rendered — which is what happens when a continuation table's <tbody> is
// resolved back through its data-ref to the source tbody, i.e. to the table's
// first row. Layout then replays the table until the chunker aborts the
// document with "Layout repeated" (portal-pdftools
// operate/self-monitoring-3-alert-list). The predicate is the trigger for
// re-measuring the page without the page area's columns; getting it wrong
// either leaves that bug unfixed or re-measures pages that are laid out fine.
describe("Layout.breakTokenRewinds", () => {

	const rewinds = (breakToken, prevBreakToken) =>
		Layout.prototype.breakTokenRewinds.call(null, breakToken, prevBreakToken);

	const fixture = () => {
		const host = document.createElement("div");
		host.innerHTML = `<table><tbody id="body">
			<tr id="first"><td id="firstCell">alpha</td></tr>
			<tr id="second"><td id="secondCell">omega</td></tr>
		</tbody></table>`;
		return host;
	};

	it("accepts a token that follows the previous one in document order", () => {
		const host = fixture();

		expect(rewinds(
			{node: host.querySelector("#secondCell").firstChild, offset: 0},
			{node: host.querySelector("#firstCell").firstChild, offset: 0})).toBe(false);
	});

	it("accepts a later offset in the same node", () => {
		const text = fixture().querySelector("#firstCell").firstChild;

		expect(rewinds({node: text, offset: 3}, {node: text, offset: 1})).toBe(false);
	});

	// No progress at all: the page would start exactly where the last one did.
	it("rejects the same node at the same or an earlier offset", () => {
		const text = fixture().querySelector("#firstCell").firstChild;

		expect(rewinds({node: text, offset: 1}, {node: text, offset: 1})).toBe(true);
		expect(rewinds({node: text, offset: 0}, {node: text, offset: 4})).toBe(true);
	});

	it("rejects a token that precedes the previous one", () => {
		const host = fixture();

		expect(rewinds(
			{node: host.querySelector("#firstCell").firstChild, offset: 0},
			{node: host.querySelector("#secondCell").firstChild, offset: 0})).toBe(true);
	});

	// The bug this exists for. A container token resumes at the container's
	// start, so an ancestor of the previous break point re-renders everything
	// between the two — here, every row of the table.
	it("rejects an ancestor of the previous break point", () => {
		const host = fixture();

		expect(rewinds(
			{node: host.querySelector("#body"), offset: 0},
			{node: host.querySelector("#secondCell").firstChild, offset: 0})).toBe(true);
	});

	// A descendant does follow the previous break point: the page stopped at the
	// container and resumes deeper inside it.
	it("accepts a descendant of the previous break point", () => {
		const host = fixture();

		expect(rewinds(
			{node: host.querySelector("#secondCell").firstChild, offset: 0},
			{node: host.querySelector("#body"), offset: 0})).toBe(false);
	});

	it("has no opinion when either token is missing a node", () => {
		const text = fixture().querySelector("#firstCell").firstChild;

		expect(rewinds(undefined, {node: text, offset: 0})).toBe(false);
		expect(rewinds({node: text, offset: 0}, undefined)).toBe(false);
		expect(rewinds({offset: 0}, {node: text, offset: 0})).toBe(false);
		expect(rewinds({node: text, offset: 0}, {offset: 0})).toBe(false);
	});
});
