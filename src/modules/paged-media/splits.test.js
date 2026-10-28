import Splits from "./splits.js";

// The column freeze is applied after the overflow has been removed, and it can
// make the page worse than it found it: rounding a fractional column width down
// rewraps a cell, pushes the last row past the content box, and the page area's
// off-page column swallows it. `afterOverflowRemoved` therefore looks at what the
// freeze did and takes it back off, so these two have to be exact inverses.
//
// jsdom has no layout, so this covers the DOM contract only — that the undo puts
// back precisely what the freeze wrote and leaves a colgroup it did not write
// alone. The geometric half of the fix is in
// `specs/splits/tables/split-table-column-freeze.spec.js`.

function splits() {
	return Object.create(Splits.prototype);
}

function table(markup) {
	let host = document.createElement("div");
	host.innerHTML = markup;
	return host.querySelector("table");
}

const THREE_ROWS = `
	<table style="width: 50%">
		<tbody>
			<tr><td>a</td><td>b</td><td>c</td></tr>
			<tr><td>d</td><td>e</td><td>f</td></tr>
		</tbody>
	</table>`;

describe("Splits column freeze", () => {
	it("pins the given widths and says it did", () => {
		let t = table(THREE_ROWS);

		expect(splits().freezeTableColumns(t, [31, 113, 77])).toBe(true);

		let cols = Array.from(t.querySelectorAll("colgroup[data-split-table-colgroup] > col"));
		expect(cols.map((c) => c.style.width)).toEqual(["31px", "113px", "77px"]);
		expect(t.style.tableLayout).toBe("fixed");
		expect(t.style.width).toBe("221px");
		expect(t.style.maxWidth).toBe("none");
	});

	it("restores the table exactly as it was", () => {
		let t = table(THREE_ROWS);
		let s = splits();

		s.freezeTableColumns(t, [31, 113, 77]);
		s.unfreezeTableColumns(t);

		expect(t.querySelector("colgroup[data-split-table-colgroup]")).toBe(null);
		expect(t.style.tableLayout).toBe("");
		expect(t.style.maxWidth).toBe("");
		// The width the document gave it, not the one the freeze wrote over it.
		expect(t.style.width).toBe("50%");
	});

	it("refuses to pin a table that is already pinned", () => {
		let t = table(THREE_ROWS);
		let s = splits();

		expect(s.freezeTableColumns(t, [31, 113, 77])).toBe(true);
		expect(s.freezeTableColumns(t, [50, 50, 50])).toBe(false);

		let cols = Array.from(t.querySelectorAll("colgroup[data-split-table-colgroup] > col"));
		expect(cols.map((c) => c.style.width)).toEqual(["31px", "113px", "77px"]);
	});

	it("leaves a colgroup it did not write where it is", () => {
		// `rebuildSplitTable` puts the same marker on continuation fragments. The
		// undo must never reach one of those: it is the only thing holding that
		// fragment's columns in line with the fragment before it.
		let t = table(`
			<table>
				<colgroup data-split-table-colgroup><col style="width: 40px"></colgroup>
				<tbody><tr><td>a</td></tr></tbody>
			</table>`);

		splits().unfreezeTableColumns(t);

		expect(t.querySelector("colgroup[data-split-table-colgroup] > col").style.width).toBe("40px");
	});
});
