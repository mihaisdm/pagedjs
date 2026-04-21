import Handler from "../handler.js";

class Splits extends Handler {
	constructor(chunker, polisher, caller) {
		super(chunker, polisher, caller);
	}

	afterPageLayout(pageElement, page, breakToken, chunker) {
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
					this.normalizeTableSplitPosition(from, prevPage);
				}
			}
		});

		// Fix alignment on the deepest split element
		if (from) {
			this.handleAlignment(from);
		}
	}

	normalizeTableSplitPosition(node, pageElement) {
		let table = node.nodeName === "TABLE" ? node : node.closest("table");
		if (!table) {
			return;
		}

		let pageBounds = pageElement.getBoundingClientRect();
		let tableBounds = table.getBoundingClientRect();
		let leftWithinPage = tableBounds.left - pageBounds.left;

		if (leftWithinPage > pageBounds.width && table.offsetLeft > 0) {
			table.style.marginLeft = (-table.offsetLeft) + "px";
		}
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
