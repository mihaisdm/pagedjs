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

// Detects nodes injected when rebuilding a split table continuation: the
// synthetic <colgroup> used to pin column widths and the replicated header.
// Both are marked with dedicated data attributes and exist only for
// presentation (their clones carry no data-ref), so the overflow/break
// machinery must ignore them. Scoped to the markers we add so native
// colgroups/headers in ordinary tables are unaffected.
function isReplicatedTableDecoration(node) {
	let element = node.nodeType === 1 ? node : node.parentElement;
	if (!element || typeof element.closest !== "function") {
		return false;
	}
	return element.closest("[data-split-table-colgroup], [data-split-table-header]") !== null;
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
		// Nothing of it fitted after all: let the continuation render the cell whole.
		return clone.textContent.length || 0;
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
		// continuation's first word.
		let first;
		while ((first = element.firstChild) &&
			!(first.textContent || "").trim().length &&
			element.childNodes.length > 1) {
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
				let removed = this.removeOverflow(overflow, breakLetter);
				this.hooks && this.hooks.afterOverflowRemoved.trigger(removed, rendered, this);
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
					}

					if (left >= end || top >= vEnd) {
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
