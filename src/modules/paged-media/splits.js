import Handler from "../handler.js";
import { SPLIT_TABLE_COL_WIDTHS } from "../../utils/dom.js";

class Splits extends Handler {
	constructor(chunker, polisher, caller) {
		super(chunker, polisher, caller);
	}

	afterPageLayout(pageElement, page, breakToken, chunker) {
		// Capture the column geometry of a table that is about to continue onto
		// the next page, before that page's fragment is rebuilt. The first
		// fragment laid out is treated as canonical and never overwritten.
		this.captureSplitTableGeometry(pageElement, breakToken, chunker);

		let splits = Array.from(pageElement.querySelectorAll("[data-split-from]"));
		let pages = pageElement.parentNode;
		let index = Array.prototype.indexOf.call(pages.children, pageElement);
		let prevPage;

		if (index === 0) {
			return;
		}

		prevPage = pages.children[index - 1];

		let from; // Capture the last from element
		splits.forEach((split) => {
			let ref = split.dataset.ref;
			// The marker itself is applied while the previous page is being laid out
			// (Layout.markContinuedFragments), so it is already present here. Match
			// on it rather than on its absence, and do not re-apply it: restyling a
			// finished page is what this moved away from.
			from = prevPage.querySelector("[data-ref='"+ ref +"']");

			if (from) {
				if (!from.dataset.splitFrom) {
					from.dataset.splitOriginal = true;
					let table = from.nodeName === "TABLE" ? from : from.closest("table");
					if (table) {
						table.dataset.splitOriginal = true;
					}
				}
			}
		});

		// Fix alignment on the deepest split element
		if (from) {
			this.handleAlignment(from);
		}
	}

	// A table laid out with `table-layout: auto` sizes its columns from its
	// content, so removing the overflow re-sizes them: the fragment that stays
	// behind is measured, a break is chosen from that measurement, and then
	// extracting the tail changes the very widths the measurement was based on.
	// A couple of pixels is enough to make an *earlier* row wrap one line further,
	// which pushes every row below it down and can carry the last line of the page
	// past the bottom of the content box. Because page content is laid out as a
	// multi-column container, such a line does not simply clip at the bottom — it
	// reflows into the next (off-page) column, where it is clipped away entirely
	// and dropped from the printed output, while the next page resumes after it.
	// Nothing re-validates the page once the overflow has been removed, so the
	// line is lost from both pages.
	//
	// Fix: measure the columns before the overflow is removed and re-apply those
	// widths afterwards, so extraction cannot change them and the layout the break
	// was computed from is preserved. The widths written are the ones the fragment
	// already had, so this pins the geometry rather than changing it.
	onOverflow(overflow, rendered, bounds, layout) {
		this.pendingColumnFreeze = undefined;

		if (!overflow || !overflow.startContainer || !rendered) {
			return;
		}

		let container = overflow.startContainer;
		let element = container.nodeType === 1 ? container : container.parentElement;
		let renderedTable = element && element.closest ? element.closest("table") : null;
		if (!renderedTable || !rendered.contains(renderedTable)) {
			return;
		}

		// Already pinned (a rebuilt continuation fragment): its widths are fixed
		// and cannot drift, so there is nothing to preserve.
		if (renderedTable.querySelector("colgroup[data-split-table-colgroup]")) {
			return;
		}

		let ref = renderedTable.getAttribute("data-ref");
		let sourceTable = ref && this.chunker && this.chunker.source
			? this.chunker.source.querySelector(`[data-ref='${ref}']`)
			: null;
		if (!sourceTable) {
			return;
		}

		// Same gates as the continuation pinning below: an ambiguous column
		// mapping, or a table with a row taller than the page, must be left alone.
		// The tall-row gate is what keeps this away from tables whose rows have to
		// split mid-row, where a fixed colgroup mispositions the fragment.
		if (this.tableHasRowspan(sourceTable)) {
			return;
		}

		let referenceRow = renderedTable.querySelector("tbody > tr");
		if (!referenceRow) {
			return;
		}

		let cells = Array.from(referenceRow.children);
		if (!cells.length || cells.some((cell) => parseInt(cell.getAttribute("colspan") || "1", 10) > 1)) {
			return;
		}

		let expectedColumns = this.tableColumnCount(sourceTable);
		if (expectedColumns && cells.length !== expectedColumns) {
			return;
		}

		let colWidths = cells.map((cell) => Math.round(cell.getBoundingClientRect().width));
		if (colWidths.some((width) => !(width > 0))) {
			return;
		}

		if (this.pinningWouldStrandRow(sourceTable, renderedTable, colWidths)) {
			return;
		}

		this.pendingColumnFreeze = { table: renderedTable, colWidths };
	}

	afterOverflowRemoved(removed, rendered, layout) {
		let pending = this.pendingColumnFreeze;
		this.pendingColumnFreeze = undefined;

		if (!pending || !rendered || !rendered.contains(pending.table)) {
			return;
		}

		this.freezeTableColumns(pending.table, pending.colWidths);
	}

	// Widths measured from a rendered fragment can be far wider than the page: a
	// cell holding one very large unbroken blob measures at its natural width, not
	// the width it was displayed at. Pinning that — which also sets
	// `max-width: none` — locks the table off the side of the page, and everything
	// past the content box is culled from the printed output.
	//
	// Measured on `self-monitoring-alarm`: a 2-column table pinned to 4252px on a
	// 665px content box (`frozenCols=[2126px,2126px]`), putting 210 words into the
	// off-page columns — more off-page content than the bug the freeze was added to
	// fix. So refuse to pin anything the page cannot show; an unpinned table may
	// have columns that drift between fragments, which is a cosmetic problem, and
	// losing the text is not.
	pinnedWidthFitsPage(table, colWidths) {
		let content = table.closest && table.closest(".pagedjs_page_content");
		let available = content ? content.getBoundingClientRect().width : 0;
		if (!(available > 0)) {
			return true;
		}
		let total = colWidths.reduce((sum, width) => sum + width, 0);
		return total <= Math.ceil(available);
	}

	// Pin `table` to the given column widths. Marked with the same
	// data-split-table-colgroup attribute the rebuilt continuations use, so the
	// overflow/break machinery keeps ignoring the injected colgroup (it carries no
	// data-ref and must never be chosen as a break point).
	freezeTableColumns(table, colWidths) {
		if (table.querySelector("colgroup[data-split-table-colgroup]")) {
			return;
		}

		if (!this.pinnedWidthFitsPage(table, colWidths)) {
			return;
		}

		let colgroup = document.createElement("colgroup");
		colgroup.setAttribute("data-split-table-colgroup", "");
		colWidths.forEach((width) => {
			let col = document.createElement("col");
			col.style.width = width + "px";
			colgroup.appendChild(col);
		});

		table.insertBefore(colgroup, table.firstChild);
		table.style.tableLayout = "fixed";
		table.style.width = colWidths.reduce((sum, width) => sum + width, 0) + "px";
		table.style.maxWidth = "none";
	}

	captureSplitTableGeometry(pageElement, breakToken, chunker) {
		if (!breakToken || !breakToken.node || !chunker || !chunker.source) {
			return;
		}

		let node = breakToken.node;
		let element = node.nodeType === 1 ? node : node.parentElement;
		let sourceTable = element && element.closest && element.closest("table");
		if (!sourceTable) {
			return;
		}

		// Canonical widths come from the first fragment only.
		if (sourceTable[SPLIT_TABLE_COL_WIDTHS]) {
			return;
		}

		let ref = sourceTable.getAttribute("data-ref");
		if (!ref) {
			return;
		}

		let renderedTable = pageElement.querySelector(`[data-ref='${ref}']`);
		if (!renderedTable) {
			return;
		}

		// A rowspan cell that carries across a page break leaves the
		// continuation fragment's rows with fewer cells than the column count;
		// pinning those rows to a fixed colgroup mangles the layout. Leave such
		// tables to the existing rowspan handling (the header is still
		// replicated separately, which is safe).
		if (this.tableHasRowspan(sourceTable)) {
			return;
		}

		// Measure a body row that maps one cell per column (no colspans),
		// otherwise the per-column mapping is ambiguous and we leave the table
		// untouched. Deliberately do NOT fall back to a header row: when a table
		// starts at the very bottom of a page only its header may fit on the
		// first fragment (no body rows), and the header's auto widths are not a
		// reliable basis for pinning the body columns.
		let referenceRow = renderedTable.querySelector("tbody > tr");
		if (!referenceRow) {
			// No body row on this fragment yet — let a later fragment that does
			// carry body rows provide the canonical widths instead.
			return;
		}
		let cells = Array.from(referenceRow.children);
		if (!cells.length || cells.some((cell) => parseInt(cell.getAttribute("colspan") || "1", 10) > 1)) {
			return;
		}

		// The reference row must account for every column. If it was measured
		// while partially laid out (fewer cells than the table has columns),
		// pinning would leave the missing columns at width 0 under
		// table-layout:fixed — collapsing their header/cell content into a
		// single character per line. Skip pinning rather than mangle the table.
		let expectedColumns = this.tableColumnCount(sourceTable);
		if (expectedColumns && cells.length !== expectedColumns) {
			return;
		}

		let colWidths = cells.map((cell) => Math.round(cell.getBoundingClientRect().width));
		if (colWidths.some((width) => !(width > 0))) {
			return;
		}

		// Do not pin a table that contains a row taller than the page content
		// area. Such a row must split across the page boundary, but pinning the
		// (often narrow) captured widths via table-layout:fixed + an explicit
		// <colgroup> on the continuation fragment breaks that mid-row split: the
		// oversized row's on-page fragment is laid out at full page height on top
		// of the rows above it, so its short leading cells (e.g. the id columns)
		// render nowhere and are silently dropped. Leaving the table unpinned lets
		// the row split cleanly. Not dropping cells matters more than perfect
		// column alignment. The tall row usually lands on a later continuation
		// page (not laid out yet at this first-fragment capture), so measure it on
		// an off-screen probe that applies the candidate pinned geometry.
		if (this.pinningWouldStrandRow(sourceTable, renderedTable, colWidths)) {
			return;
		}

		if (!this.pinnedWidthFitsPage(renderedTable, colWidths)) {
			return;
		}

		sourceTable[SPLIT_TABLE_COL_WIDTHS] = colWidths;
	}

	// True if, at the candidate pinned column widths, any body row of the source
	// table would render taller than the space available below the replicated
	// header on a continuation page. Such a row cannot be placed on a
	// continuation fragment and is stranded by the split machinery. Measured on an
	// off-screen clone because the source table is display:none and the tall row
	// is usually not laid out yet when this first-fragment capture runs.
	pinningWouldStrandRow(sourceTable, renderedTable, colWidths) {
		let area = renderedTable.closest && renderedTable.closest(".pagedjs_area");
		let pageHeight = area ? area.getBoundingClientRect().height : 0;
		if (!(pageHeight > 0)) {
			return false;
		}

		let probe = document.createElement("div");
		probe.setAttribute("aria-hidden", "true");
		probe.style.cssText = "position:absolute;left:-99999px;top:0;visibility:hidden;";
		let clone = sourceTable.cloneNode(true);
		Array.from(clone.querySelectorAll("colgroup")).forEach((cg) => cg.remove());
		clone.style.tableLayout = "fixed";
		clone.style.width = colWidths.reduce((sum, width) => sum + width, 0) + "px";
		clone.style.maxWidth = "none";
		let colgroup = document.createElement("colgroup");
		colWidths.forEach((width) => {
			let col = document.createElement("col");
			col.style.width = width + "px";
			colgroup.appendChild(col);
		});
		clone.insertBefore(colgroup, clone.firstChild);
		probe.appendChild(clone);
		document.body.appendChild(probe);

		let stranded = false;
		try {
			let thead = clone.querySelector("thead");
			let available = pageHeight - (thead ? thead.getBoundingClientRect().height : 0);
			stranded = Array.from(clone.querySelectorAll("tbody > tr"))
				.some((row) => row.getBoundingClientRect().height > available);
		} finally {
			document.body.removeChild(probe);
		}
		return stranded;
	}

	tableHasRowspan(table) {
		return Array.from(table.querySelectorAll("[rowspan]"))
			.some((cell) => parseInt(cell.getAttribute("rowspan") || "1", 10) > 1);
	}

	// Number of columns the table actually has, taken as the widest row
	// (summing colspans). Used to reject a reference row that was measured
	// while only partially laid out.
	tableColumnCount(table) {
		let max = 0;
		for (let row of Array.from(table.rows || [])) {
			let count = 0;
			for (let cell of Array.from(row.cells || [])) {
				count += cell.colSpan || 1;
			}
			max = Math.max(max, count);
		}
		return max;
	}

	handleAlignment(node) {
		let styles = window.getComputedStyle(node);
		let align = styles["text-align"];
		let alignLast = styles["text-align-last"];
		node.dataset.lastSplitElement = "true";
		if (align === "justify" && alignLast === "auto") {
			node.dataset.alignLastSplitElement = "justify";
		} else {
			node.dataset.alignLastSplitElement = alignLast;
		}
	}

}

export default Splits;
