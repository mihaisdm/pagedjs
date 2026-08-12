import { indexOfTextNode, rebuildAncestors, withoutInsertedHyphen } from "./dom.js";

// Breaking a page inside a word appends a hyphen glyph to the text that stays
// behind (Layout.hyphenateAtBreak). The rendered text is then NOT a substring of
// the source text it came from, so mapping it back to the source — which is how
// a break token is built — has to ignore that glyph. When it did not, the lookup
// failed, createBreakToken returned undefined, and no break token could be built
// at all: content that had overflowed into the off-page column stayed there and
// was dropped from the printed output.
describe("withoutInsertedHyphen", () => {

	it("strips the hyphen glyphs a break can insert", () => {
		expect(withoutInsertedHyphen("Accessibilit‑")).toEqual("Accessibilit");
		expect(withoutInsertedHyphen("Accessibilit‐")).toEqual("Accessibilit");
		expect(withoutInsertedHyphen("Accessibilit­")).toEqual("Accessibilit");
		expect(withoutInsertedHyphen("Accessibilit-")).toEqual("Accessibilit");
	});

	it("only strips at the end, and leaves ordinary text alone", () => {
		expect(withoutInsertedHyphen("Multi‑part name")).toEqual("Multi‑part name");
		expect(withoutInsertedHyphen("well-known")).toEqual("well-known");
		expect(withoutInsertedHyphen("plain text")).toEqual("plain text");
	});

	it("passes through non-strings untouched", () => {
		expect(withoutInsertedHyphen(undefined)).toBeUndefined();
		expect(withoutInsertedHyphen(null)).toBeNull();
	});

});

describe("indexOfTextNode", () => {

	// A cell like the ones this bug was found in: several text children, the
	// break falling inside the last one.
	function sourceCell() {
		let td = document.createElement("td");
		td.appendChild(document.createTextNode("Denotes the answered rate of the Mobile Calls. "));
		td.appendChild(document.createTextNode(" Calculated as: "));
		td.appendChild(document.createTextNode(" Number of Answered Calls / Number of Call Attempts. "));
		return td;
	}

	it("finds a text node that is rendered verbatim", () => {
		let td = sourceCell();
		let rendered = document.createTextNode(" Calculated as: ");
		expect(indexOfTextNode(rendered, td)).toEqual(1);
	});

	it("finds a text node truncated at a page break", () => {
		let td = sourceCell();
		let rendered = document.createTextNode(" Number of Answered Calls / Number");
		expect(indexOfTextNode(rendered, td)).toEqual(2);
	});

	// The regression: same truncation, but the break fell inside a word, so a
	// hyphen glyph was appended and the text is no longer a substring.
	it("finds a truncated text node that a break hyphenated", () => {
		let td = sourceCell();
		let rendered = document.createTextNode(" Number of Answered Calls / Num‑");
		expect(indexOfTextNode(rendered, td)).toEqual(2);
	});

	it("still reports -1 when the text genuinely is not there", () => {
		let td = sourceCell();
		expect(indexOfTextNode(document.createTextNode("nothing like it"), td)).toEqual(-1);
	});

	it("reports -1 for a node that is not a text node", () => {
		let td = sourceCell();
		expect(indexOfTextNode(document.createElement("span"), td)).toEqual(-1);
	});

});

// Laying the same content out twice happens whenever a page is retried — the
// `hasMeaningfulContent` retry in Page.layout already does it, and any
// re-validation of a page will too. rebuildAncestors rewrites a table row in
// place to fill in cells carried down by a rowspan (upstream #239), so it has to
// be safe to call more than once on the same row.
describe("rebuildAncestors rowspan fill", () => {

	function cell(text, rowSpan) {
		let td = document.createElement("td");
		td.textContent = text;
		if (rowSpan) td.rowSpan = rowSpan;
		return td;
	}

	function cells(tr) {
		return Array.from(tr.children).map((c) => c.textContent);
	}

	function tableWithRows(rows) {
		let table = document.createElement("table");
		let tbody = document.createElement("tbody");
		table.appendChild(tbody);
		rows.forEach((r) => tbody.appendChild(r));
		return table;
	}

	it("fills a continuation row with the cell carried down by a rowspan", () => {
		let first = document.createElement("tr");
		first.appendChild(cell("SPAN", 3));
		first.appendChild(cell("a1"));
		first.appendChild(cell("b1"));
		let second = document.createElement("tr");
		second.appendChild(cell("a2"));
		second.appendChild(cell("b2"));
		tableWithRows([first, second]);

		expect(cells(second)).toEqual(["a2", "b2"]);
		rebuildAncestors(second);
		expect(cells(second)).toEqual(["SPAN", "a2", "b2"]);
	});

	it("is idempotent for a single rowspan", () => {
		let first = document.createElement("tr");
		first.appendChild(cell("SPAN", 3));
		first.appendChild(cell("a1"));
		first.appendChild(cell("b1"));
		let second = document.createElement("tr");
		second.appendChild(cell("a2"));
		second.appendChild(cell("b2"));
		tableWithRows([first, second]);

		rebuildAncestors(second);
		let afterFirst = cells(second);
		rebuildAncestors(second);
		rebuildAncestors(second);
		expect(cells(second)).toEqual(afterFirst);
	});

	// The regression: two rowspans of different lengths. Here the guard inside the
	// fill cannot tell that the row was already filled, and every extra call used
	// to prepend another copy of the carried-down cell.
	it("is idempotent with two rowspans of different lengths", () => {
		let first = document.createElement("tr");
		first.appendChild(cell("A", 3));
		first.appendChild(cell("B", 2));
		first.appendChild(cell("c1"));
		first.appendChild(cell("d1"));
		let second = document.createElement("tr");
		second.appendChild(cell("c2"));
		second.appendChild(cell("d2"));
		let third = document.createElement("tr");
		third.appendChild(cell("c3"));
		tableWithRows([first, second, third]);

		rebuildAncestors(third);
		expect(cells(third)).toEqual(["A", "c3"]);

		rebuildAncestors(third);
		expect(cells(third)).toEqual(["A", "c3"]);
		rebuildAncestors(third);
		expect(cells(third)).toEqual(["A", "c3"]);
	});

});
