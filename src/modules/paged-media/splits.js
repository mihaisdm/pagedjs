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
			from = prevPage.querySelector("[data-ref='"+ ref +"']:not([data-split-to])");

			if (from) {
				from.dataset.splitTo = ref;

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

		// Measure a row that maps one cell per column (no colspans), otherwise
		// the per-column mapping is ambiguous and we leave the table untouched.
		let referenceRow = renderedTable.querySelector("tbody > tr") || renderedTable.querySelector("tr");
		if (!referenceRow) {
			return;
		}
		let cells = Array.from(referenceRow.children);
		if (!cells.length || cells.some((cell) => parseInt(cell.getAttribute("colspan") || "1", 10) > 1)) {
			return;
		}

		let colWidths = cells.map((cell) => Math.round(cell.getBoundingClientRect().width));
		if (colWidths.some((width) => !(width > 0))) {
			return;
		}

		sourceTable[SPLIT_TABLE_COL_WIDTHS] = colWidths;
	}

	tableHasRowspan(table) {
		return Array.from(table.querySelectorAll("[rowspan]"))
			.some((cell) => parseInt(cell.getAttribute("rowspan") || "1", 10) > 1);
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
