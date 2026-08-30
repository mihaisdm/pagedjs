import { getBoundingClientRect, getClientRects } from "../utils/utils.js";
import {
	breakInsideAvoidParentNode,
	child,
	cloneNode,
	findElement,
	hasContent,
	indexOf,
	indexOfTextNode,
	isContainer,
	isElement,
	isText,
	letters,
	needsBreakBefore,
	needsPageBreak,
	needsPreviousBreakAfter,
	nodeAfter,
	nodeBefore,
	parentOf,
	prevValidNode,
	rebuildAncestors,
	validNode,
	walk,
	withoutInsertedHyphen,
	words
} from "../utils/dom.js";
import BreakToken from "./breaktoken.js";
import RenderResult, { OverflowContentError } from "./renderresult.js";
import EventEmitter from "event-emitter";
import Hook from "../utils/hook.js";

const MAX_CHARS_PER_BREAK = 1500;

// When a table would be split such that its first fragment keeps this many
// rendered rows or fewer (the header counts), and there is other content above
// it on the page, push the whole table to the next page instead of leaving an
// orphaned header (or a sliver of rows) stranded at the bottom of the page.
const MAX_ORPHANED_TABLE_ROWS = 3;

// How many times one page may re-break after discovering that extraction pushed
// content off-page. Each pass moves the break strictly earlier, so this only
// bounds pathological input; two passes clear every case seen so far.
const MAX_OFFPAGE_REBREAKS = 3;

// Detects nodes injected when rebuilding a split table continuation: the
// synthetic <colgroup> used to pin column widths, a copy of the source table's
// own <colgroup>, and the replicated header. All are marked with dedicated data
// attributes and exist only for presentation (their clones carry no data-ref),
// so the overflow/break machinery must ignore them. Scoped to the markers we add
// so native colgroups/headers in ordinary tables are unaffected.
function isReplicatedTableDecoration(node) {
	let element = node.nodeType === 1 ? node : node.parentElement;
	if (!element || typeof element.closest !== "function") {
		return false;
	}
	return element.closest("[data-split-table-colgroup], [data-split-table-source-colgroup], [data-split-table-header]") !== null;
}

function describeNodeForDebug(node) {
	if (typeof window !== "undefined" && typeof window.__PRINT_DESCRIBE_NODE__ === "function") {
		return window.__PRINT_DESCRIBE_NODE__(node);
	}

	return node;
}

function describeBreakTokenForDebug(token) {
	if (!token) {
		return null;
	}

	let serialized = null;
	if (typeof token.toJSON === "function") {
		try {
			serialized = JSON.parse(token.toJSON());
		} catch (error) {
			serialized = token.toJSON();
		}
	}

	return {
		offset: token.offset,
		serialized,
		node: describeNodeForDebug(token.node),
	};
}

function logUnableToLayout(details) {
	console.warn("Unable to layout item " + JSON.stringify(details));
}

/**
 * Layout
 * @class
 */
class Layout {

	constructor(element, hooks, options) {
		this.element = element;

		this.bounds = this.element.getBoundingClientRect();
		this.parentBounds = this.element.offsetParent.getBoundingClientRect();
		let gap = parseFloat(window.getComputedStyle(this.element).columnGap);
	
		if (gap) {
			let leftMargin = this.bounds.left - this.parentBounds.left;
			this.gap =  gap - leftMargin;	
		} else {
			this.gap = 0;
		}

		if (hooks) {
			this.hooks = hooks;
		} else {
			this.hooks = {};
			this.hooks.onPageLayout = new Hook();
			this.hooks.layout = new Hook();
			this.hooks.renderNode = new Hook();
			this.hooks.layoutNode = new Hook();
			this.hooks.beforeOverflow = new Hook();
			this.hooks.onOverflow = new Hook();
			this.hooks.afterOverflowRemoved = new Hook();
			this.hooks.onBreakToken = new Hook();
			this.hooks.beforeRenderResult = new Hook();
		}

		this.settings = options || {};

		this.maxChars = this.settings.maxChars || MAX_CHARS_PER_BREAK;
		this.forceRenderBreak = false;
	}

	async renderTo(wrapper, source, breakToken, bounds = this.bounds) {
		let start = this.getStart(source, breakToken);
		let walker = walk(start, source);

		let node;
		let prevNode;
		let done;
		let next;

		let hasRenderedContent = false;
		let newBreakToken;

		let length = 0;

		let prevBreakToken = breakToken || new BreakToken(start);

		// Cells whose content the previous page already rendered ahead of the break, so
		// the row's later columns sat beside the broken cell instead of jumping a page.
		let emittedCells = (breakToken && breakToken.emittedCells) || [];

		this.hooks && this.hooks.onPageLayout.trigger(wrapper, prevBreakToken, this);

		while (!done && !newBreakToken) {
			next = walker.next();
			prevNode = node;
			node = next.value;
			done = next.done;

			if (!node) {
				this.hooks && this.hooks.layout.trigger(wrapper, this);

				let imgs = wrapper.querySelectorAll("img");
				if (imgs.length) {
					await this.waitForImages(imgs);
				}

				newBreakToken = this.findBreakToken(wrapper, source, bounds, prevBreakToken, true, node);

				if (newBreakToken && newBreakToken.equals(prevBreakToken)) {
					logUnableToLayout({
						reason: "end-of-content-no-progress",
						node: describeNodeForDebug(prevNode),
						prevBreakToken: describeBreakTokenForDebug(prevBreakToken),
						newBreakToken: describeBreakTokenForDebug(newBreakToken),
					});
					this.hooks && this.hooks.beforeRenderResult.trigger(undefined, wrapper, this);
					return new RenderResult(undefined, new OverflowContentError("Unable to layout item", [prevNode]));
				}

				this.rebuildTableFromBreakToken(newBreakToken, wrapper, bounds, emittedCells);

				this.hooks && this.hooks.beforeRenderResult.trigger(newBreakToken, wrapper, this);
				return new RenderResult(newBreakToken);
			}

			this.hooks && this.hooks.layoutNode.trigger(node);

			// Check if the rendered element has a break set
			if (hasRenderedContent && this.shouldBreak(node, start)) {
				this.hooks && this.hooks.layout.trigger(wrapper, this);

				let imgs = wrapper.querySelectorAll("img");
				if (imgs.length) {
					await this.waitForImages(imgs);
				}

				newBreakToken = this.findBreakToken(wrapper, source, bounds, prevBreakToken, true, node);

				if (!newBreakToken) {
					newBreakToken = this.breakAt(node);
				} else {
					this.rebuildTableFromBreakToken(newBreakToken, wrapper, bounds, emittedCells);
				}

				if (newBreakToken && newBreakToken.equals(prevBreakToken)) {
					let after = newBreakToken.node && nodeAfter(newBreakToken.node);
					if (after) {
						newBreakToken = new BreakToken(after);
					} else {
						logUnableToLayout({
							reason: "forced-break-no-progress",
							node: describeNodeForDebug(node),
							prevBreakToken: describeBreakTokenForDebug(prevBreakToken),
							newBreakToken: describeBreakTokenForDebug(newBreakToken),
						});
						return new RenderResult(undefined, new OverflowContentError("Unable to layout item", [node]));
					}
				}

				length = 0;

				break;
			}

			if (node.dataset && node.dataset.page) {
				let named = node.dataset.page;
				let page = this.element.closest(".pagedjs_page");
				page.classList.add("pagedjs_named_page");
				page.classList.add("pagedjs_" + named + "_page");

				if (!node.dataset.splitFrom) {
					page.classList.add("pagedjs_" + named + "_first_page");
				}
			}

			// A cell whose content was already emitted on the page this row broke from
			// must not render it again. Keep the empty cell box so the continuation row
			// still has all its columns, and skip its children.
			if (node.nodeName === "TD") {
				let already = null;
				for (let i = 0; i < emittedCells.length; i++) {
					if (emittedCells[i].cell === node) { already = emittedCells[i]; break; }
				}
				if (already) {
					// `null` for the break token, deliberately: it points into the cell the
					// row broke inside, and `append` applies its text offset to whatever it
					// clones. Handing it a different cell lets that offset shift this
					// cell's text, so the character count below no longer lines up.
					if (already.chars === -1) {
						// Shown whole on the previous page: an empty box keeps the column.
						this.append(node, wrapper, null, true);
					} else {
						this.dropLeadingText(
							this.append(node, wrapper, null, false), already.chars);
					}
					walker = walk(nodeAfter(node, source), source);
					continue;
				}
			}

			// Should the Node be a shallow or deep clone
			let shallow = isContainer(node);

			let rendered = this.append(node, wrapper, breakToken, shallow);

			length += rendered.textContent.length;

			// Check if layout has content yet
			if (!hasRenderedContent) {
				hasRenderedContent = hasContent(node);
			}

			// Skip to the next node if a deep clone was rendered
			if (!shallow) {
				walker = walk(nodeAfter(node, source), source);
			}

			if (this.forceRenderBreak) {
				this.hooks && this.hooks.layout.trigger(wrapper, this);

				newBreakToken = this.findBreakToken(wrapper, source, bounds, prevBreakToken);

				if (!newBreakToken) {
					newBreakToken = this.breakAt(node);
				} else {
					this.rebuildTableFromBreakToken(newBreakToken, wrapper, bounds, emittedCells);
				}

				length = 0;
				this.forceRenderBreak = false;

				break;
			}

			// Only check x characters
			if (length >= this.maxChars) {

				this.hooks && this.hooks.layout.trigger(wrapper, this);

				let imgs = wrapper.querySelectorAll("img");
				if (imgs.length) {
					await this.waitForImages(imgs);
				}

				newBreakToken = this.findBreakToken(wrapper, source, bounds, prevBreakToken, true, node);

				if (newBreakToken) {
					length = 0;
					this.rebuildTableFromBreakToken(newBreakToken, wrapper, bounds, emittedCells);
				}

				if (newBreakToken && newBreakToken.equals(prevBreakToken)) {
					let after = newBreakToken.node && nodeAfter(newBreakToken.node);
					if (after) {
						newBreakToken = new BreakToken(after);
					} else {
						logUnableToLayout({
							reason: "max-chars-no-progress",
							node: describeNodeForDebug(node),
							prevBreakToken: describeBreakTokenForDebug(prevBreakToken),
							newBreakToken: describeBreakTokenForDebug(newBreakToken),
							length,
							maxChars: this.maxChars,
						});
						this.hooks && this.hooks.beforeRenderResult.trigger(undefined, wrapper, this);
						return new RenderResult(undefined, new OverflowContentError("Unable to layout item", [node]));
					}
				}
			}

		}

		this.hooks && this.hooks.beforeRenderResult.trigger(newBreakToken, wrapper, this);
		return new RenderResult(newBreakToken);
	}

	breakAt(node, offset = 0) {
		let newBreakToken = new BreakToken(
			node,
			offset
		);
		let breakHooks = this.hooks.onBreakToken.triggerSync(newBreakToken, undefined, node, this);
		breakHooks.forEach((newToken) => {
			if (typeof newToken != "undefined") {
				newBreakToken = newToken;
			}
		});

		return newBreakToken;
	}

	findFallbackBreakToken(prevBreakToken, source, fallbackNode) {
		if (fallbackNode) {
			return this.breakAt(fallbackNode);
		}

		if (prevBreakToken && prevBreakToken.node) {
			if (isText(prevBreakToken.node)) {
				let nextOffset = prevBreakToken.offset + 1;
				if (nextOffset < prevBreakToken.node.textContent.length) {
					return this.breakAt(prevBreakToken.node, nextOffset);
				}
			}

			let after = nodeAfter(prevBreakToken.node, source);
			if (after) {
				return this.breakAt(after);
			}
		}
	}

	findAncestorTable(node) {
		if (!node) {
			return;
		}

		if (isText(node)) {
			return node.parentElement && node.parentElement.closest("table");
		}

		return node.nodeName === "TABLE" ? node : node.closest("table");
	}

	shouldBreak(node, limiter) {
		let previousNode = nodeBefore(node, limiter);
		let parentNode = node.parentNode;
		let parentBreakBefore = needsBreakBefore(node) && parentNode && !previousNode && needsBreakBefore(parentNode);
		let doubleBreakBefore;

		if (parentBreakBefore) {
			doubleBreakBefore = node.dataset.breakBefore === parentNode.dataset.breakBefore;
		}

		return !doubleBreakBefore && needsBreakBefore(node) || needsPreviousBreakAfter(node) || needsPageBreak(node, previousNode);
	}

	forceBreak() {
		this.forceRenderBreak = true;
	}

	getStart(source, breakToken) {
		let start;
		let node = breakToken && breakToken.node;

		if (node) {
			start = node;
		} else {
			start = source.firstChild;
		}

		return start;
	}

	append(node, dest, breakToken, shallow = true, rebuild = true) {

		let clone = cloneNode(node, !shallow);

		if (node.parentNode && isElement(node.parentNode)) {
			let parent = findElement(node.parentNode, dest);
			// Rebuild chain
			if (parent) {
				parent.appendChild(clone);
			} else if (rebuild) {
				let fragment = rebuildAncestors(node);
				parent = findElement(node.parentNode, fragment);
				if (!parent) {
					dest.appendChild(clone);
				} else if (breakToken && isText(breakToken.node) && breakToken.offset > 0) {
					clone.textContent = clone.textContent.substring(breakToken.offset);
					parent.appendChild(clone);
				} else {
					parent.appendChild(clone);
				}

				dest.appendChild(fragment);
			} else {
				dest.appendChild(clone);
			}


		} else {
			dest.appendChild(clone);
		}

		if (clone.dataset && clone.dataset.ref) {
			if (!dest.indexOfRefs) {
				dest.indexOfRefs = {};
			}
			dest.indexOfRefs[clone.dataset.ref] = clone;
		}

		let nodeHooks = this.hooks.renderNode.triggerSync(clone, node, this);
		nodeHooks.forEach((newNode) => {
			if (typeof newNode != "undefined") {
				clone = newNode;
			}
		});

		return clone;
	}

	// Trim a rendered cell to the lines that fit above `limit.bottom`, and return how
	// many characters were kept: -1 when it already fitted whole, 0 when nothing fitted.
	//
	// This is what lets a row break like a row. The page break cuts the row at one
	// height, so every cell of it should show the content above that line and continue
	// the rest -- not survive whole or jump a page as a unit.
	trimCellToFit(clone, limit) {
		let box = getBoundingClientRect(clone);

		// Wholly inside the page: nothing to do.
		if (box.right <= limit.right + 0.5 && box.bottom <= limit.bottom + 0.5) {
			return -1;
		}
		// Wholly in the off-page column: none of it is on this page.
		if (box.left >= limit.right) {
			return 0;
		}

		// Otherwise it straddles. Note the criterion: a cell whose content does not fit
		// is not clipped at the page bottom, it is flowed into paged.js's off-page second
		// column (see section 3), so its rect spans both columns -- left inside the content
		// box, right out at ~2500px. "Does this character fit" therefore means "is it
		// still in the first column", not "is it above the page bottom". Testing the
		// bottom alone finds no cut point at all and the cell gets moved whole.
		const fits = (rect) => rect.right <= limit.right + 0.5 && rect.bottom <= limit.bottom + 0.5;

		let walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
		let node, cutNode = null, cutOffset = 0;
		while ((node = walker.nextNode())) {
			let len = node.textContent.length;
			if (!len) {
				continue;
			}
			let whole = document.createRange();
			whole.selectNodeContents(node);
			if (fits(getBoundingClientRect(whole))) {
				continue;
			}
			// This text node straddles the boundary. Find the largest prefix still on page.
			let lo = 0, hi = len;
			while (lo < hi) {
				let mid = Math.ceil((lo + hi) / 2);
				let probe = document.createRange();
				probe.setStart(node, 0);
				probe.setEnd(node, mid);
				if (fits(getBoundingClientRect(probe))) {
					lo = mid;
				} else {
					hi = mid - 1;
				}
			}
			cutNode = node;
			cutOffset = lo;
			break;
		}

		// No text crossed the boundary, so the cell's CONTENT fits -- even though its box
		// did not. A <td> stretches to the height of its ROW, so for a short cell in a tall
		// row `box.bottom` is the row's bottom and reports an overflow the text does not
		// have. Returning 0 here emptied every short cell of a splitting row (the reported
		// case: columns 3, 4 and 6 blank while 2 and 5 split correctly). Measure the text.
		if (!cutNode) {
			return -1;
		}
		let tail = document.createRange();
		tail.setStart(cutNode, cutOffset);
		tail.setEndAfter(clone.lastChild);
		tail.deleteContents();
		// `Range.deleteContents()` only removes content; a boundary container that
		// was only PARTIALLY selected (the <li> the cut landed in, when none of its
		// own text made the cut) survives as an empty element -- a bare bullet with
		// nothing beside it. Symmetric to dropLeadingText's leading-side cleanup.
		this.removeEmptyTrailingChildren(clone);
		// Nothing of it fitted after all: let the continuation render the cell whole.
		return clone.textContent.length || 0;
	}

	removeEmptyTrailingChildren(element) {
		let last;
		while ((last = element.lastChild)) {
			if (last.nodeType !== 1) {
				if ((last.textContent || "").trim().length) { break; }
				if (element.childNodes.length <= 1) { break; }
				last.remove();
				continue;
			}
			if (last.nodeName === "IMG" || (last.querySelector && last.querySelector("img"))) { break; }
			if ((last.textContent || "").trim().length) {
				this.removeEmptyTrailingChildren(last);
				break;
			}
			if (element.childNodes.length <= 1) { break; }
			last.remove();
		}
	}

	// Remove the first `count` characters of text from a cell rendered on a continuation
	// page, because they were already shown on the page the row broke from. Counting
	// characters rather than mapping nodes is exact here: both copies are clones of the
	// same source cell, so their text nodes correspond one for one.
	dropLeadingText(element, count) {
		let walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
		let node, remaining = count;
		while (remaining > 0 && (node = walker.nextNode())) {
			let len = node.textContent.length;
			if (len <= remaining) {
				remaining -= len;
				node.textContent = "";
			} else {
				node.textContent = node.textContent.substring(remaining);
				remaining = 0;
			}
		}
		// Blocks and <br>s emptied above would otherwise print as blank lines before the
		// continuation's first word. A <ul> whose first few <li>s were just emptied is
		// NOT itself empty (later <li>s still hold text), so a single pass over
		// `element`'s own children stops immediately and leaves bare, textless bullets
		// sitting above the continuation -- descend into whichever child still has text
		// and repeat there.
		this.removeEmptyLeadingChildren(element);
	}

	removeEmptyLeadingChildren(element) {
		let first;
		while ((first = element.firstChild)) {
			if (first.nodeType !== 1) {
				if ((first.textContent || "").trim().length) { break; }
				// Don't remove the only remaining node -- leaving nothing behind is
				// worse than one stray empty text node.
				if (element.childNodes.length <= 1) { break; }
				first.remove();
				continue;
			}
			if (first.nodeName === "IMG" || (first.querySelector && first.querySelector("img"))) { break; }
			if ((first.textContent || "").trim().length) {
				// `first` (e.g. a <ul>) is not itself empty overall -- its LATER
				// children still hold text -- but its own leading children (e.g. the
				// first few now-emptied <li>s) may need the same cleanup. Recurse
				// into it rather than stopping here, which is what a same-level-only
				// check on `element.childNodes.length` used to prevent.
				this.removeEmptyLeadingChildren(first);
				break;
			}
			if (element.childNodes.length <= 1) { break; }
			first.remove();
		}
	}

	// When a row breaks inside a cell the break point is one position in document order,
	// so the rest of that cell AND every later cell of the row travel to the next page.
	// Upstream compensated by appending the following cells here as EMPTY boxes
	// (`shallow`), which completes the row's borders but leaves the reader with blank
	// columns on one page and the earlier columns blank on the other.
	//
	// Instead they are appended with their content, trimmed to what fits, and recorded on
	// the break token so the continuation renders the remainder rather than the whole cell
	// again. A cell that fits nothing here is left entirely to the continuation.
	//
	// The fit check is what makes this safe. This runs AFTER removeOverflow, so nothing
	// downstream re-validates what is appended: recording a cell that overhangs the page
	// means it is culled from the PDF and skipped on the continuation, i.e. lost. Measured
	// without the check: eolive-catalog 399 -> 384 pages and 9231 characters gone.
	rebuildTableFromBreakToken(breakToken, dest, bounds, alreadyEmitted) {
		if (!breakToken || !breakToken.node) {
			return;
		}
		let node = breakToken.node;
		let td = isElement(node) ? node.closest("td") : node.parentElement.closest("td");
		if (td) {
			let rendered = findElement(td, dest, true);
			if (!rendered) {
				return;
			}
			let limit = (bounds || this.bounds);
			let emitted = [];
			let prior = alreadyEmitted || [];
			while ((td = td.nextElementSibling)) {
				// A row can span three or more pages. On the second continuation this cell
				// may ALREADY have had a prefix shown, so re-appending it whole and trimming
				// from its start would repeat that prefix. Carry the count forward.
				let before = 0;
				for (let i = 0; i < prior.length; i++) {
					if (prior[i].cell === td) { before = prior[i].chars; break; }
				}
				if (before === -1) {
					// Finished on an earlier page: an empty box keeps the column.
					this.append(td, dest, null, true);
					emitted.push({ cell: td, chars: -1 });
					continue;
				}
				let clone = this.append(td, dest, null, false);
				if (before > 0) {
					this.dropLeadingText(clone, before);
				}
				let kept = this.trimCellToFit(clone, limit);
				if (kept === 0) {
					// None of the remainder fits. Leave an empty box; the continuation picks
					// up from the same place, so the record must survive unchanged.
					clone.parentNode.replaceChild(cloneNode(td, false), clone);
					if (before > 0) {
						emitted.push({ cell: td, chars: before });
					}
				} else if (kept === -1) {
					emitted.push({ cell: td, chars: -1 });
				} else {
					emitted.push({ cell: td, chars: before + kept });
				}
			}
			// Recorded on the break token, not on the source cell. The token is the unit of
			// work the next page is rendered from, so the list is scoped to exactly the
			// attempt that produced it. That matters because Page.render lays a page out
			// again into a shorter box (the off-page re-validation loop): a cell that fitted
			// on one attempt may not on the next, and a discarded attempt's token is simply
			// dropped along with its list. State kept on the source instead would leak
			// between attempts -- a marker left by a discarded attempt makes the
			// continuation skip content nothing ever emitted, which is silent loss.
			breakToken.emittedCells = emitted;
		}
	}

	removeRenderedContentAfterBreakToken(breakToken, rendered) {
		if (!breakToken || !breakToken.node) {
			return;
		}

		let sourceNode = breakToken.node;
		let renderedNode;
		if (isText(sourceNode)) {
			let renderedParent = findElement(sourceNode.parentNode, rendered, true);
			if (!renderedParent) {
				return;
			}

			let index = indexOfTextNode(sourceNode, sourceNode.parentNode);
			if (index === -1) {
				return;
			}

			renderedNode = child(renderedParent, index) || renderedParent;
		} else {
			renderedNode = findElement(sourceNode, rendered, true);
		}

		if (!renderedNode) {
			return;
		}

		let trimStart = renderedNode;
		let tableRow = isElement(renderedNode)
			? parentOf(renderedNode, "TR", rendered)
			: parentOf(renderedNode.parentNode, "TR", rendered);
		if (tableRow) {
			trimStart = tableRow;
		}

		let range = document.createRange();
		range.setStartBefore(trimStart);
		range.setEndAfter(rendered.lastChild);
		return range.extractContents();
	}

	getRenderedPageContentBounds(rendered) {
		let pageElement = rendered.closest(".pagedjs_page");
		let contentElement = pageElement && pageElement.querySelector(".pagedjs_page_content");
		let boundsElement = contentElement || pageElement;

		if (!pageElement || !boundsElement) {
			return;
		}

		return {
			pageElement,
			boundsElement,
			bounds: boundsElement.getBoundingClientRect()
		};
	}

	findOffPageSplitCandidate(rendered) {
		let pageInfo = this.getRenderedPageContentBounds(rendered);
		if (!pageInfo) {
			return;
		}

		let {bounds} = pageInfo;
		let splitElements = Array.from(rendered.querySelectorAll("[data-split-from]"));
		let candidates = [];

		splitElements.forEach((element) => {
			if (["TABLE", "IMG", "SVG", "CANVAS"].includes(element.nodeName)) {
				candidates.push(element);
			}

			candidates.push(...element.querySelectorAll("table, img, svg, canvas"));
		});

		return candidates.find((candidate) => {
			let rect = candidate.getBoundingClientRect();
			return rect.width > 0 && rect.left >= bounds.right;
		});
	}

	normalizeOffPageSplitContent(rendered) {
		let pageInfo = this.getRenderedPageContentBounds(rendered);
		if (!pageInfo) {
			return false;
		}

		let {bounds} = pageInfo;
		let adjusted = false;
		let candidate = this.findOffPageSplitCandidate(rendered);
		let seen = new Set();

		while (candidate && !seen.has(candidate)) {
			seen.add(candidate);
			let rect = candidate.getBoundingClientRect();
			let currentMarginLeft = parseFloat(window.getComputedStyle(candidate).marginLeft) || 0;
			let shift = rect.left - bounds.left;

			candidate.style.marginLeft = (currentMarginLeft - shift) + "px";
			candidate.style.marginRight = "0px";
			adjusted = true;

			candidate = this.findOffPageSplitCandidate(rendered);
		}

		return adjusted;
	}

	// The first element that is wholly in the off-page column, in document order.
	//
	// Returned without descending into it: the outermost such box is the one to
	// break before, because moving it takes its content with it. Elements that
	// generate no box of their own (`display: contents`, and the tab panels this
	// was found through) have no rects to judge, so the walk goes through them
	// rather than treating them as on-page.
	//
	// Judged on `getClientRects`, never on the bounding rect: a box that begins in
	// column 1 and continues into the off-page column reports a union whose `left`
	// is column 1's, which hides the fragment that matters (AGENTS.md).
	firstOffPageElement(rendered, bounds = this.bounds) {
		let walker = document.createTreeWalker(rendered, NodeFilter.SHOW_ELEMENT);
		let node;
		while ((node = walker.nextNode())) {
			if (isReplicatedTableDecoration(node)) {
				continue;
			}
			if (!node.textContent || !node.textContent.trim()) {
				continue;
			}
			let rects = Array.from(getClientRects(node) || []).filter((rect) => rect.width > 0 && rect.height > 0);
			if (!rects.length) {
				continue;
			}
			if (rects.every((rect) => rect.left >= bounds.right - 0.5)) {
				return node;
			}
		}
	}

	// Re-check the page after the overflow has been extracted, and break again if
	// extraction made it worse.
	//
	// `findOverflow` measures the page as it stands, then `removeOverflow` takes
	// the overflow out — and that reflows what remains. Content that fitted when
	// it was measured can end up in the off-page column, where it is laid out,
	// invisible, and dropped from the PDF: it appears on neither this page nor the
	// next, because the break token says it was already rendered. Nothing else
	// looks at the page again once the break is chosen.
	//
	// Found on a documentation manual whose content-tab block sat inside a grid:
	// removing the code block that followed the tabs let the tab panel reflow, and
	// a three-item list that had fitted moved into the off-page column and was
	// lost. The walk had seen exactly one overflow candidate, the code block, and
	// was right about it at the time.
	//
	// Each pass breaks before the off-page box, which is strictly earlier in the
	// content than the break just taken, so the loop makes progress. A break that
	// would rewind past the token this page began at cannot be taken -- that is
	// the "page cannot hold this at all" case -- so it is reported and the
	// original break stands rather than looping.
	rebreakOffPageAfterExtraction(rendered, source, bounds, breakToken, prevBreakToken) {
		for (let pass = 0; pass < MAX_OFFPAGE_REBREAKS; pass++) {
			let offPage = this.firstOffPageElement(rendered, bounds);
			if (!offPage) {
				return breakToken;
			}

			let range = document.createRange();
			range.selectNode(offPage);

			let rebroken = this.createBreakToken(range, rendered, source);
			if (!rebroken || !rebroken.node || this.breakTokenRewinds(rebroken, prevBreakToken)) {
				// Nothing safe to do: breaking here would rewind past the token this page
				// started from. The original break stands, exactly as it did before this
				// re-validation existed, so this is not a failure and must not be reported
				// as one -- `logUnableToLayout` warns, and a consumer that treats browser
				// warnings as fatal then refuses a manual that renders correctly. Measured:
				// `deploy-maintain/self-monitoring-alarm` exports 204 pages here, matching
				// pdf-tools 5.1.0-0.174 page for page, while the warning alone blocked it.
				return breakToken;
			}

			let removed = this.removeOverflow(range);
			this.hooks && this.hooks.afterOverflowRemoved.trigger(removed, rendered, this);
			breakToken = rebroken;
		}
		return breakToken;
	}

	describeRenderedSplitCandidate(candidate, rendered) {
		let pageInfo = this.getRenderedPageContentBounds(rendered);
		if (!pageInfo || !candidate) {
			return;
		}

		let {bounds} = pageInfo;
		let rect = candidate.getBoundingClientRect();

		return {
			tag: candidate.nodeName,
			ref: candidate.dataset && candidate.dataset.ref,
			leftWithinPage: Math.round(rect.left - bounds.left),
			rightWithinPage: Math.round(rect.right - bounds.left),
			pageWidth: Math.round(bounds.width),
			offsetLeft: candidate.offsetLeft
		};
	}

	async waitForImages(imgs) {
		let results = Array.from(imgs).map(async (img) => {
			return this.awaitImageLoaded(img);
		});
		await Promise.all(results);
	}

	async awaitImageLoaded(image) {
		return new Promise(resolve => {
			if (image.complete !== true) {
				image.onload = function () {
					let {width, height} = window.getComputedStyle(image);
					resolve(width, height);
				};
				image.onerror = function (e) {
					let {width, height} = window.getComputedStyle(image);
					resolve(width, height, e);
				};
			} else {
				let {width, height} = window.getComputedStyle(image);
				resolve(width, height);
			}
		});
	}

	avoidBreakInside(node, limiter) {
		let breakNode;

		if (node === limiter) {
			return;
		}

		while (node.parentNode) {
			node = node.parentNode;

			if (node === limiter) {
				break;
			}

			if (window.getComputedStyle(node)["break-inside"] === "avoid") {
				breakNode = node;
				break;
			}

		}
		return breakNode;
	}

	// A `break-inside: avoid` cell asks that the whole row move to the next page
	// rather than break mid-cell — which is what a reader needs, because a break
	// inside one cell strands every cell after it in document order on the next
	// page, leaving the row's columns staggered across the boundary instead of
	// side by side.
	//
	// NOTE: unreachable from portal-pdftools today. Nothing there declares
	// `break-inside: avoid` on a cell, because doing so exposes a separate upstream
	// defect: the move-the-whole-row branch drops rows outright (eoXDR loses a
	// ~4200-character table row and duplicates a page). This guard is still correct
	// and still required — it is what stops the branch stalling layout on rows too
	// tall to move — so it stays, ready for whoever fixes the row-dropping. See
	// portal-pdftools/docs/offpage-column-content-loss.md §13.
	//
	// Moving the row only helps when an earlier body row of the same table is
	// already on this page: the row then began partway down it, and the next page
	// has more room. When the row is the first one on the page there is nowhere to
	// move it to — `findBreakToken` would name the same row again, the chunker
	// would see the break token repeat, and layout would stop with the rest of the
	// document unrendered. Those rows must keep splitting in place, staggered
	// columns and all.
	//
	// Decided from content rather than geometry, like `hasRenderedContentBefore`:
	// a continuation page carries a replicated header, so the first row on it does
	// NOT start at the top of the content box and any position-based test would
	// read it as movable.
	//
	// Header rows are excluded on both sides. A `thead` cell never moves its row,
	// and a preceding header does not make the first body row movable — pushing
	// that row alone would strand the header. `orphanTableForNode` already handles
	// that case by moving the whole table, and returning false here is what lets
	// it: this branch runs first and would otherwise preempt it.
	// Walks backwards from `row` rather than querying the table. This is reached
	// from the `findOverflow` walker, so it runs on every overflow probe of every
	// page; `table.querySelectorAll("tbody > tr")` would materialise the whole row
	// list each time, and the reference manuals are single tables running to 700+
	// pages. Walking previous siblings answers in one step for the common case —
	// the row above has text — and never builds a list.
	rowCanMoveToNextPage(row) {
		if (!row || row.nodeName !== "TR") {
			return false;
		}
		let body = row.parentElement;
		if (!body || body.nodeName !== "TBODY") {
			return false;
		}
		for (let sibling = row.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
			if (sibling.nodeName === "TR" && sibling.textContent.trim().length) {
				return true;
			}
		}
		// Confluence exports occasionally split a table's rows over several tbody
		// groups, so an earlier group counts too.
		for (let group = body.previousElementSibling; group; group = group.previousElementSibling) {
			if (group.nodeName === "TBODY" && group.textContent.trim().length) {
				return true;
			}
		}
		return false;
	}

	// Walk up from `node` to `container`, looking for any earlier sibling that
	// carries rendered content. Used to tell whether a table sits at the very
	// top of a (fresh) page or whether other content precedes it: a table at
	// the top must never be pushed further (it would make no progress), while
	// one preceded by content can be moved down to avoid an orphaned header.
	// Content-based rather than position-based so page margins/padding do not
	// make it fire spuriously at the top of the page.
	hasRenderedContentBefore(node, container) {
		let current = node;
		while (current && current !== container) {
			let sibling = current.previousElementSibling;
			while (sibling) {
				if (sibling.textContent && sibling.textContent.trim().length) {
					return true;
				}
				sibling = sibling.previousElementSibling;
			}
			current = current.parentElement;
		}
		return false;
	}

	// If `node` is the overflow point that marks a (non-continuation) table
	// *starting* near the bottom of a page that already carries content, return
	// that table so the whole thing can be pushed to the next page. Otherwise
	// null. "Starting" means the overflow is a structural boundary
	// (table/section-group/row not inside a cell) OR a cell in the header or the
	// very first body row — the header fits but the first row does not, or the
	// header itself overflows. A cell overflow in a later body row is genuine
	// body splitting and is left alone. Handles both element and text overflow
	// nodes, so it can be shared by the element- and text-level break paths.
	orphanTableForNode(node, rendered) {
		let el = isElement(node) ? node : node.parentElement;
		let table = el && el.closest && el.closest("table");
		if (!table || table.hasAttribute("data-split-from")) {
			return null;
		}
		let cell = el.closest("td, th");
		let atStart;
		if (!cell) {
			atStart = isElement(node) &&
				["TABLE", "THEAD", "TBODY", "TFOOT", "TR"].includes(node.nodeName);
		} else {
			let firstBodyRow = table.querySelector("tbody > tr");
			atStart = !!cell.closest("thead") || cell.closest("tr") === firstBodyRow;
		}
		if (!atStart) {
			return null;
		}
		let keptRows = Array.from(table.querySelectorAll("tr"))
			.filter((row) => row !== node &&
				(node.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_PRECEDING))
			.length;
		if (keptRows <= MAX_ORPHANED_TABLE_ROWS && this.hasRenderedContentBefore(table, rendered)) {
			return table;
		}
		return null;
	}

	createBreakToken(overflow, rendered, source) {
		let container = overflow.startContainer;
		let offset = overflow.startOffset;
		let node, renderedNode, parent, index, temp;

		if (isElement(container)) {
			temp = child(container, offset);

			if (isElement(temp)) {
				renderedNode = findElement(temp, rendered);

				if (!renderedNode) {
					// Find closest element with data-ref
					let prevNode = prevValidNode(temp);
					if (!isElement(prevNode)) {
						prevNode = prevNode.parentElement;
					}
					renderedNode = findElement(prevNode, rendered);
					// Check if temp is the last rendered node at its level.
					if (!temp.nextSibling) {
						// We need to ensure that the previous sibling of temp is fully rendered.
						const renderedNodeFromSource = findElement(renderedNode, source);
						const walker = document.createTreeWalker(renderedNodeFromSource, NodeFilter.SHOW_ELEMENT);
						// Descend to the DEEPEST last descendant, not just the immediate
						// last child. A large container (e.g. a whole chapter <section>)
						// can have its immediate last child rendered while deeper content
						// inside it is still pending; checking only the immediate child
						// would wrongly treat the container as complete and emit a break
						// token pointing past the unrendered tail — silently dropping the
						// container's remaining content (e.g. whole subsections).
						// Also guards the leaf case: if renderedNode has no element
						// children, walker.lastChild() returns null and we skip the check
						// (findElement(null, …) would otherwise look like pending content).
						let deepLastDescendant = null, lastWalkStep;
						while ((lastWalkStep = walker.lastChild())) { deepLastDescendant = lastWalkStep; }
						if (deepLastDescendant) {
							const deepLastDescendantInRendered = findElement(deepLastDescendant, rendered);
							// If the deepest last descendant of the source node is not yet
							// in the rendered output, there is still pending content.
							if (!deepLastDescendantInRendered) {
								// Pending content to be rendered before virtual break token
								return;
							}
						}
						// Otherwise we will return a break token as per below
					}
					// renderedNode is actually the last unbroken box that does not overflow.
					// Break Token is therefore the next sibling of renderedNode within source node.
					node = findElement(renderedNode, source).nextSibling;
					offset = 0;
				} else {
					node = findElement(renderedNode, source);
					offset = 0;
				}
			} else {
				renderedNode = findElement(container, rendered);

				if (!renderedNode) {
					renderedNode = findElement(prevValidNode(container), rendered);
				}

				parent = findElement(renderedNode, source);

				// Prefer POSITION over text matching. indexOfTextNode returns the first
				// text child whose content *contains* temp's, which is the wrong node
				// whenever a cell repeats a string -- and separator-style cells repeat
				// them constantly ("OR" between bracketed terms). Resolving to the earlier
				// twin makes the continuation resume before the point the page actually
				// ended, so everything in between prints on both pages. Measured on
				// eoLive Dataviews p283/p284: 73 characters repeated, from an "OR" that
				// matched an identical "OR" nine children earlier.
				//
				// When the rendered container is a complete copy of its source node their
				// childNodes line up one for one, so the overflow's own child offset is
				// already the answer. The text search is only needed for a continuation
				// fragment, whose children are a subset and whose indices really do differ.
				let positional = null;
				if (parent && !container.hasAttribute("data-split-from") &&
					container.childNodes.length === parent.childNodes.length) {
					positional = child(parent, overflow.startOffset);
				}

				if (positional) {
					node = positional;
					offset = 0;
				} else {
					index = indexOfTextNode(temp, parent);
					// No seperatation for the first textNode of an element
					if(index === 0) {
						node = parent;
						offset = 0;
					} else {
						node = child(parent, index);
						offset = 0;
					}
				}
			}
		} else {
			renderedNode = findElement(container.parentNode, rendered);

			if (!renderedNode) {
				renderedNode = findElement(prevValidNode(container.parentNode), rendered);
			}

			parent = findElement(renderedNode, source);
			index = indexOfTextNode(container, parent);

			if (index === -1) {
				return;
			}

			node = child(parent, index);

			// Where the rendered slice begins inside the source text. Matched
			// without any hyphen glyph the break inserted, for the same reason
			// indexOfTextNode has to. A miss must not be added blindly: -1 would
			// silently shift the break one character earlier.
			let sliceStart = node.textContent.indexOf(container.textContent);
			if (sliceStart === -1) {
				sliceStart = node.textContent.indexOf(withoutInsertedHyphen(container.textContent));
			}
			if (sliceStart > 0) {
				offset += sliceStart;
			}
		}

		if (!node) {
			return;
		}

		return new BreakToken(
			node,
			offset
		);

	}

	// True when resuming from `breakToken` would re-render content that
	// `prevBreakToken` already placed: its node is the same one with an earlier
	// (or equal) offset, precedes it in document order, or contains it — a
	// container break token resumes at the container's start, so an ancestor of
	// the previous break point is a rewind too.
	breakTokenRewinds(breakToken, prevBreakToken) {
		if (!breakToken || !breakToken.node || !prevBreakToken || !prevBreakToken.node) {
			return false;
		}
		if (breakToken.node === prevBreakToken.node) {
			return (breakToken.offset || 0) <= (prevBreakToken.offset || 0);
		}
		let position = prevBreakToken.node.compareDocumentPosition(breakToken.node);
		if (position & Node.DOCUMENT_POSITION_CONTAINS) {
			return true;
		}
		return !(position & Node.DOCUMENT_POSITION_FOLLOWING);
	}

	// Overflow as the page area would see it if it were a single column: the
	// area is a multi-column container (`column-width` is set to the content
	// width in `Page.create`, which is what puts overflowing content in the
	// off-page column), and dropping that lets the browser lay the content out
	// in document order down the page instead of moving a box that does not fit
	// sideways. Only the measurement changes — the columns are put back before
	// anything is removed.
	findOverflowWithoutColumns(rendered, bounds = this.bounds) {
		let area = rendered && rendered.parentNode;
		if (!area || !isElement(area)) {
			return;
		}
		let columnWidth = area.style.columnWidth;
		let columnCount = area.style.columnCount;
		// The wrapper inherits the area's height, so without this the content
		// would overflow a box that still measures exactly one page: `hasOverflow`
		// looks at the wrapper's own height and the area's scroll extent, and both
		// would report no overflow at all once it is no longer flowing sideways.
		let height = rendered.style.height;
		area.style.columnWidth = "auto";
		area.style.columnCount = "auto";
		rendered.style.height = "auto";
		this.detectStraddlingOverflow = true;
		try {
			return this.findOverflow(rendered, bounds);
		} finally {
			this.detectStraddlingOverflow = false;
			area.style.columnWidth = columnWidth;
			area.style.columnCount = columnCount;
			rendered.style.height = height;
		}
	}

	// Mark, at the moment the break is chosen, the rendered fragments that will be
	// continued on the next page.
	//
	// This used to be done by `Splits.afterPageLayout` while laying out the *next*
	// page, which meant a finished page was restyled after it had been measured:
	// base.js drops the bottom margin and padding of a `[data-split-to]` box, so
	// the page reflowed against a break that had been computed from different
	// geometry. Where that reflow carried content into the page area's off-page
	// column it was lost outright -- laid out, invisible, dropped from the PDF, on
	// neither page. Removing the marker again does not restore the layout, so the
	// page could not be repaired afterwards; it has to be laid out correctly.
	//
	// Marking here, before the overflow is removed and before the page is measured
	// again, makes "the page is laid out in the styling it will finally have" an
	// invariant rather than something that happens to hold.
	//
	// The chain is taken from the break token's source ancestors: those are exactly
	// the nodes `rebuildAncestors` will clone onto the next page, so they are
	// exactly the fragments that continue. Each is mapped back to its rendered
	// counterpart through `data-ref`.
	markContinuedFragments(rendered, breakToken) {
		if (!breakToken || !breakToken.node) {
			return [];
		}
		let marked = [];
		let start = isElement(breakToken.node) ? breakToken.node : breakToken.node.parentElement;
		for (let ancestor = start; ancestor; ancestor = ancestor.parentElement) {
			let fragment = findElement(ancestor, rendered);
			if (!fragment || fragment.hasAttribute("data-split-to")) {
				continue;
			}
			let ref = fragment.getAttribute("data-ref");
			if (!ref) {
				continue;
			}
			fragment.setAttribute("data-split-to", ref);
			marked.push(fragment);
		}
		return marked;
	}

	unmarkContinuedFragments(marked) {
		marked.forEach((fragment) => fragment.removeAttribute("data-split-to"));
	}

	findBreakToken(rendered, source, bounds = this.bounds, prevBreakToken, extract = true, fallbackNode) {
		let overflow = this.findOverflow(rendered, bounds);
		let breakToken, breakLetter, fallbackBreakToken;

		let overflowHooks = this.hooks.onOverflow.triggerSync(overflow, rendered, bounds, this);
		overflowHooks.forEach((newOverflow) => {
			if (typeof newOverflow != "undefined") {
				overflow = newOverflow;
			}
		});

		if (overflow) {
			breakToken = this.createBreakToken(overflow, rendered, source);

			// A break token that does not advance past the one this page started
			// from means the page area's column layout moved content the page had
			// already begun rendering, not that the content genuinely belongs to
			// the next page.
			//
			// It happens to the tail fragment of a row that spans several pages.
			// The fragment is shorter than the page content box but taller than
			// what is left of it under the replicated header, so Chromium pushes
			// the whole row into an off-page column instead of fragmenting it in
			// place — pushing is only refused for a box that would not fit an
			// empty fragmentainer either. The overflow walk then meets the
			// continuation `tbody` before any of its text, and `createBreakToken`
			// resolves it through `data-ref` to the *source* tbody, i.e. to the
			// first row of the whole table. Layout rewinds there, replays every
			// page of the table, and the chunker stops the document with "Layout
			// repeated" (self-monitoring-3-alert-list, a 60-row table whose tail
			// fragment came out 890.83px against 888.89px of room).
			//
			// Re-measure with the column fragmentation switched off. The row then
			// sits where the page means it to — directly under the header — and
			// overflows the content box downwards, so the ordinary text-level
			// break search finds the line to break at. The break is a node and an
			// offset, so it stays valid once the columns are restored, and
			// removing that tail leaves a row that does fit.
			if (this.breakTokenRewinds(breakToken, prevBreakToken)) {
				let unpushed = this.findOverflowWithoutColumns(rendered, bounds);
				if (unpushed) {
					let unpushedToken = this.createBreakToken(unpushed, rendered, source);
					if (unpushedToken && !this.breakTokenRewinds(unpushedToken, prevBreakToken)) {
						overflow = unpushed;
						breakToken = unpushedToken;
					}
				}
			}

			// breakToken is nullable
			let breakHooks = this.hooks.onBreakToken.triggerSync(breakToken, overflow, rendered, this);
			breakHooks.forEach((newToken) => {
				if (typeof newToken != "undefined") {
					breakToken = newToken;
				}
			});

			if (breakToken &&
				breakToken["node"] &&
				typeof breakToken["offset"] !== "undefined" &&
				breakToken["node"].textContent) {
				breakLetter = breakToken["node"].textContent.charAt(breakToken["offset"]);
			} else {
				breakLetter = undefined;
			}

			if (breakToken && breakToken.equals(prevBreakToken)) {
				fallbackBreakToken = this.findFallbackBreakToken(prevBreakToken, source, fallbackNode);
				if (fallbackBreakToken && fallbackBreakToken.equals(prevBreakToken)) {
					fallbackBreakToken = undefined;
				}
			}

			if (fallbackBreakToken) {
				if (extract) {
					let removed = this.removeRenderedContentAfterBreakToken(fallbackBreakToken, rendered);
					if (removed) {
						this.hooks && this.hooks.afterOverflowRemoved.trigger(removed, rendered, this);
					}
					this.normalizeOffPageSplitContent(rendered);
					let offPageCandidate = this.findOffPageSplitCandidate(rendered);
					if (offPageCandidate) {
						logUnableToLayout({
							reason: "fallback-hidden-content",
							node: describeNodeForDebug(fallbackBreakToken.node),
							candidate: this.describeRenderedSplitCandidate(offPageCandidate, rendered),
						});
					}
				}
				return fallbackBreakToken;
			}

			if (breakToken && breakToken.node && extract) {
				// Apply the continuation styling first, then re-measure: if it changed
				// where the page ends, the break is recomputed against the layout the
				// page will actually keep. Only then is the overflow removed.
				let marked = this.markContinuedFragments(rendered, breakToken);
				if (marked.length) {
					let remeasured = this.findOverflow(rendered, bounds);
					if (remeasured) {
						let restyledToken = this.createBreakToken(remeasured, rendered, source);
						if (restyledToken && restyledToken.node &&
							!this.breakTokenRewinds(restyledToken, prevBreakToken)) {
							overflow = remeasured;
							breakToken = restyledToken;
							// The chain can have changed with the break.
							this.unmarkContinuedFragments(marked);
							this.markContinuedFragments(rendered, breakToken);
							breakLetter = breakToken.node.textContent
								? breakToken.node.textContent.charAt(breakToken.offset)
								: undefined;
						}
					}
				}

				let removed = this.removeOverflow(overflow, breakLetter);
				this.hooks && this.hooks.afterOverflowRemoved.trigger(removed, rendered, this);
				breakToken = this.rebreakOffPageAfterExtraction(
					rendered, source, bounds, breakToken, prevBreakToken);
			}

			if (breakToken && breakToken.equals(prevBreakToken)) {
				return breakToken;
			}
		}
		return breakToken;
	}

	// Heights of the line boxes that ended up laid out past the right edge of the
	// content box, i.e. in the off-page column of the multi-column container this
	// page is. Such text is laid out but invisible: Chromium keeps
	// partially-clipped glyphs when printing and culls fully-clipped ones, so it
	// is dropped from the PDF silently, appearing on neither this page nor the
	// next.
	//
	// Measured per line rect, never on a node's bounding rect: a text node whose
	// lines straddle the column break has a bounding rect whose `left` is the
	// column-1 left, which hides the off-page fragment entirely.
	//
	// Replicated table decoration is ignored: paged.js injects a header clone (and
	// a synthetic colgroup) onto continuation fragments, the break machinery
	// already skips those, and they carry no content of their own, so an empty
	// replicated header pushed off-page loses nothing and must not trigger a
	// re-layout.
	offPageColumnLines(rendered, bounds = this.bounds) {
		let heights = [];
		let walker = document.createTreeWalker(rendered, NodeFilter.SHOW_TEXT);
		let node;
		while ((node = walker.nextNode())) {
			if (!node.textContent || !node.textContent.trim()) {
				continue;
			}
			if (isReplicatedTableDecoration(node)) {
				continue;
			}
			let rects = getClientRects(node);
			if (!rects) {
				continue;
			}
			for (let rect of Array.from(rects)) {
				if (rect.width > 0 && rect.height > 0 && rect.left >= bounds.right - 0.5) {
					heights.push(rect.height);
				}
			}
		}
		return heights;
	}

	hasOverflow(element, bounds = this.bounds) {
		let constrainingElement = element && element.parentNode; // this gets the element, instead of the wrapper for the width workaround
		let {width, height} = element.getBoundingClientRect();
		let scrollWidth = constrainingElement ? constrainingElement.scrollWidth : 0;
		let scrollHeight = constrainingElement ? constrainingElement.scrollHeight : 0;
		return Math.max(Math.floor(width), scrollWidth) > Math.round(bounds.width) ||
			Math.max(Math.floor(height), scrollHeight) > Math.round(bounds.height);
	}

	findOverflow(rendered, bounds = this.bounds, gap = this.gap) {
		if (!this.hasOverflow(rendered, bounds)) return;

		let start = Math.floor(bounds.left);
		let end = Math.round(bounds.right + gap);
		let vStart = Math.round(bounds.top);
		let vEnd = Math.round(bounds.bottom);
		let range;

		let walker = walk(rendered.firstChild, rendered);

		// Find Start
		let next, done, node, offset, skip, breakAvoid, prev, br;
		while (!done) {
			next = walker.next();
			done = next.done;
			node = next.value;
			skip = false;
			breakAvoid = false;
			prev = undefined;
			br = undefined;

			// A replicated table header (and the synthetic colgroup that pins
			// column widths on continuation fragments) is decoration injected
			// during rebuild. It carries no data-ref and must never be chosen
			// as an overflow / break point.
			if (node && isReplicatedTableDecoration(node)) {
				continue;
			}

			if (node) {
				let pos = getBoundingClientRect(node);
				let left = Math.round(pos.left);
				let right = Math.floor(pos.right);
				let top = Math.round(pos.top);
				let bottom = Math.floor(pos.bottom);

				if (!range && (left >= end || top >= vEnd)) {
					// Check if it is a float
					let isFloat = false;

					// Check if the node is inside a break-inside: avoid table cell
					const insideTableCell = parentOf(node, "TD", rendered);
					const avoidInsideCell = insideTableCell &&
						window.getComputedStyle(insideTableCell)["break-inside"] === "avoid" &&
						this.rowCanMoveToNextPage(insideTableCell.parentElement);
					if (avoidInsideCell) {
						// breaking inside a table cell produces unexpected result, as a workaround, we forcibly avoid break inside in a cell.
						// But we take the whole row, not just the cell that is causing the break.
						prev = insideTableCell.parentElement;
					} else if (isElement(node)) {
						let styles = window.getComputedStyle(node);
						isFloat = styles.getPropertyValue("float") !== "none";
						skip = styles.getPropertyValue("break-inside") === "avoid";
						breakAvoid = node.dataset.breakBefore === "avoid" || node.dataset.previousBreakAfter === "avoid";
						prev = breakAvoid && nodeBefore(node, rendered);
						br = node.tagName === "BR" || node.tagName === "WBR";
					}

					let tableRow;
					if (node.nodeName === "TR") {
						tableRow = node;
					} else {
						tableRow = parentOf(node, "TR", rendered);
					}
					if (tableRow) {
						// honor break-inside="avoid" in parent tbody/thead
						let container = tableRow.parentElement;
						if (["TBODY", "THEAD"].includes(container.nodeName)) {
							let styles = window.getComputedStyle(container);
							if (styles.getPropertyValue("break-inside") === "avoid") prev = container;
						}

						// Check if the node is inside a row with a rowspan
						const table = parentOf(tableRow, "TABLE", rendered);
						const rowspan = table.querySelector("[colspan]");
						if (table && rowspan) {
							let columnCount = 0;
							for (const cell of Array.from(table.rows[0].cells)) {
								columnCount += parseInt(cell.getAttribute("colspan") || "1");
							}
							if (tableRow.cells.length !== columnCount) {
								let previousRow = tableRow.previousElementSibling;
								let previousRowColumnCount;
								while (previousRow !== null) {
									previousRowColumnCount = 0;
									for (const cell of Array.from(previousRow.cells)) {
										previousRowColumnCount += parseInt(cell.getAttribute("colspan") || "1");
									}
									if (previousRowColumnCount === columnCount) {
										break;
									}
									previousRow = previousRow.previousElementSibling;
								}
								if (previousRowColumnCount === columnCount) {
									prev = previousRow;
								}
							}
						}
					}

					// Orphan control: the overflow can land on a row, on the
					// tbody, or on the table itself. In every case, if this is
					// the first fragment of the table (not a continuation) and
					// only a few rows (the header included) would remain on a
					// page that already carries other content, push the whole
					// table to the next page rather than leaving an orphaned
					// header / row sliver behind (which would also force the
					// header to repeat on the following continuation page).
					//
					// The kept-row count is derived from document order rather
					// than geometry: while a table is being laid out past the
					// page bottom its overflowing rows are not yet reliably
					// positioned, so we count the <tr>s that precede the overflow
					// node (the first content bound for the next page) instead.
					if (!prev) {
						// Only treat this as a table-start orphan when the overflow
						// lands on a structural boundary (the table, a section group
						// or a whole row that is bound for the next page). When it
						// lands inside a cell, an earlier row has already started on
						// this page and its tall content is merely splitting — that
						// is not a table starting near the page bottom, so the table
						// must keep splitting in place rather than being moved.
						let orphanTable = this.orphanTableForNode(node, rendered);
						if (orphanTable) {
							prev = orphanTable;
						}
					}

					if (prev) {
						range = document.createRange();
						range.selectNode(prev);
						break;
					}

					if (!br && !isFloat && isElement(node)) {
						range = document.createRange();
						range.selectNode(node);
						break;
					}

					if (isText(node) && node.textContent.trim().length) {
						range = document.createRange();
						range.selectNode(node);
						break;
					}

				}

				if (!range && isText(node) &&
					node.textContent.trim().length &&
					!breakInsideAvoidParentNode(node.parentNode)) {

					let rects = getClientRects(node);
					let rect;
					let bottom = 0;
					left = 0;
					top = 0;
					for (var i = 0; i != rects.length; i++) {
						rect = rects[i];
						if (rect.width > 0 && (!left || rect.left > left)) {
							left = rect.left;
						}
						if (rect.height > 0 && (!top || rect.top > top)) {
							top = rect.top;
						}
						if (rect.height > 0 && rect.bottom > bottom) {
							bottom = rect.bottom;
						}
					}

					// `top >= vEnd` cannot see a line that merely *straddles* the bottom
					// of the content box: its top is still inside. In the page's own
					// column layout that never matters, because a column never lets a
					// line straddle its end — the line is moved to the next column
					// whole, where `left >= end` catches it. It matters only while
					// `findOverflowWithoutColumns` is measuring with the columns off,
					// which is the one case where a straddling line is what we are
					// looking for. `textBreak` already breaks at the first word of such
					// a line.
					//
					// The flag must stay off everywhere else. Switched on for ordinary
					// layout it would move any line whose last fraction of a pixel
					// crosses the bound to the next page, repaginating every document
					// that has one.
					if (left >= end || top >= vEnd ||
						(this.detectStraddlingOverflow && bottom > vEnd)) {
						// A table starting near the page bottom overflows at the text
						// level (its header / first-row text exceeds the bound) before
						// any element boundary does, so the element-level orphan check
						// above is bypassed. Apply the same orphan control here: push
						// the whole table to the next page instead of stranding its
						// header.
						let orphanTable = this.orphanTableForNode(node, rendered);
						if (orphanTable) {
							range = document.createRange();
							range.selectNode(orphanTable);
							break;
						}
						range = document.createRange();
						offset = this.textBreak(node, start, end, vStart, vEnd);
						if (typeof offset === "undefined") {
							// No break point inside this text node.
							range = undefined;
						} else if (offset === 0) {
							// The very first line of the node already crosses the bound, so
							// there is nothing of it to keep on this page. Offset 0 only
							// became reachable once a vertical straddle started breaking at
							// the start of its line (see textBreak), and it must not be
							// conflated with "no break found" — doing so leaves the page with
							// no break token at all and the straddling line clipped, which is
							// the bug that fix addresses.
							//
							// Inside a table this means the row's *first* line straddles the
							// page bottom, so the row cannot be split here at all: breaking
							// before this cell's text would still strand the first line of
							// every other cell in the row below the content box — including
							// short single-line cells (an id column, say) that have no later
							// line to be pushed down and would simply vanish. Move the whole
							// row instead. Only when a preceding row with content stays
							// behind, so the page keeps something and the break is guaranteed
							// to advance; a first body row is left to the orphan handling
							// above and to plain node-level breaking.
							let straddlingRow = parentOf(node, "TR", rendered);
							let precedingRow = straddlingRow && straddlingRow.previousElementSibling;
							while (precedingRow &&
								!(precedingRow.textContent && precedingRow.textContent.trim().length)) {
								precedingRow = precedingRow.previousElementSibling;
							}

							if (straddlingRow && precedingRow) {
								range.selectNode(straddlingRow);
							} else {
								range.selectNode(node);
							}
						} else {
							range.setStart(node, offset);
						}
						break;
					}
				}

				// Skip children
				if (skip || (right <= end && bottom <= vEnd)) {
					next = nodeAfter(node, rendered);
					if (next) {
						walker = walk(next, rendered);
					}

				}

			}
		}

		// Find End
		if (range) {
			range.setEndAfter(rendered.lastChild);
			return range;
		}

	}

	findEndToken(rendered, source) {
		if (rendered.childNodes.length === 0) {
			return;
		}

		let lastChild = rendered.lastChild;

		let lastNodeIndex;
		while (lastChild && lastChild.lastChild) {
			if (!validNode(lastChild)) {
				// Only get elements with refs
				lastChild = lastChild.previousSibling;
			} else if (!validNode(lastChild.lastChild)) {
				// Deal with invalid dom items
				lastChild = prevValidNode(lastChild.lastChild);
				break;
			} else {
				lastChild = lastChild.lastChild;
			}
		}

		if (isText(lastChild)) {

			if (lastChild.parentNode.dataset.ref) {
				lastNodeIndex = indexOf(lastChild);
				lastChild = lastChild.parentNode;
			} else {
				lastChild = lastChild.previousSibling;
			}
		}

		let original = findElement(lastChild, source);
		if (!original) {
			return;
		}

		if (lastNodeIndex) {
			original = original.childNodes[lastNodeIndex];
		}
		if (!original) {
			return;
		}

		let after = nodeAfter(original);
		if (!after) {
			return;
		}

		return this.breakAt(after);
	}

	textBreak(node, start, end, vStart, vEnd) {
		let wordwalker = words(node);
		let left = 0;
		let right = 0;
		let top = 0;
		let bottom = 0;
		let word, next, done, pos;
		let offset;
		while (!done) {
			next = wordwalker.next();
			word = next.value;
			done = next.done;

			if (!word) {
				break;
			}

			pos = getBoundingClientRect(word);

			left = Math.floor(pos.left);
			right = Math.floor(pos.right);
			top = Math.floor(pos.top);
			bottom = Math.floor(pos.bottom);

			if (left >= end || top >= vEnd) {
				offset = word.startOffset;
				break;
			}

			// Horizontal overflow: the bound falls *inside* this word, so the break
			// point is a specific letter. Walk the letters to find the one that
			// crosses it.
			if (right > end) {
				let letterwalker = letters(word);
				let letter, nextLetter, doneLetter;

				while (!doneLetter) {
					nextLetter = letterwalker.next();
					letter = nextLetter.value;
					doneLetter = nextLetter.done;

					if (!letter) {
						break;
					}

					pos = getBoundingClientRect(letter);
					left = Math.floor(pos.left);
					top = Math.floor(pos.top);

					if (left >= end || top >= vEnd) {
						offset = letter.startOffset;
						done = true;

						break;
					}
				}
			}

			// Vertical overflow: this word sits on a line that crosses the bottom of
			// the page content box. A line of text cannot be split across that
			// boundary, so the whole line has to move to the next page — break at
			// this word. It is necessarily the *first* word of the straddling line,
			// because every word on the lines above it ended above the bound.
			//
			// Letter-walking a vertical overflow (as the horizontal case above does)
			// is what this replaces, and it silently dropped a line of text: every
			// letter on the straddling line shares the same `top`, so none of them
			// satisfies `top >= vEnd` and the walk runs on into the *next* line,
			// returning that line's offset. The straddling line then stayed on the
			// current page — below the content box, clipped away by its
			// overflow:hidden — while the next page resumed after it. Chromium drops
			// fully clipped glyphs when printing, so such a line appeared on neither
			// page (e.g. a table cell reading "Common - eNodeB Name <br><br> S1 -
			// PDN Connectivity Reject Cause" lost the "S1 - PDN" line at the break).
			if (typeof offset === "undefined" && bottom > vEnd) {
				offset = word.startOffset;
				break;
			}

		}

		return offset;
	}

	removeOverflow(overflow, breakLetter) {
		let {startContainer} = overflow;
		let extracted = overflow.extractContents();

		this.hyphenateAtBreak(startContainer, breakLetter);

		return extracted;
	}

	hyphenateAtBreak(startContainer, breakLetter) {
		if (isText(startContainer)) {
			let startText = startContainer.textContent;
			let prevLetter = startText[startText.length - 1];

			// Add a hyphen if previous character is a letter or soft hyphen
			if (
				(breakLetter && /^\w|\u00AD$/.test(prevLetter) && /^\w|\u00AD$/.test(breakLetter)) ||
				(!breakLetter && /^\w|\u00AD$/.test(prevLetter))
			) {
				startContainer.parentNode.classList.add("pagedjs_hyphen");
				startContainer.textContent += this.settings.hyphenGlyph || "\u2011";
			}
		}
	}

	equalTokens(a, b) {
		if (!a || !b) {
			return false;
		}
		if (a["node"] && b["node"] && a["node"] !== b["node"]) {
			return false;
		}
		if (a["offset"] && b["offset"] && a["offset"] !== b["offset"]) {
			return false;
		}
		return true;
	}
}

EventEmitter(Layout.prototype);

export default Layout;
