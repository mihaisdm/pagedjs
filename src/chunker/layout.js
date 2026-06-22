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
	words
} from "../utils/dom.js";
import BreakToken from "./breaktoken.js";
import RenderResult, { OverflowContentError } from "./renderresult.js";
import EventEmitter from "event-emitter";
import Hook from "../utils/hook.js";

const MAX_CHARS_PER_BREAK = 1500;

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

				this.rebuildTableFromBreakToken(newBreakToken, wrapper);

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
					this.rebuildTableFromBreakToken(newBreakToken, wrapper);
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
					this.rebuildTableFromBreakToken(newBreakToken, wrapper);
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
					this.rebuildTableFromBreakToken(newBreakToken, wrapper);
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

	rebuildTableFromBreakToken(breakToken, dest) {
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
			while ((td = td.nextElementSibling)) {
				this.append(td, dest, null, true);
			}
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

			offset += node.textContent.indexOf(container.textContent);
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
					if (insideTableCell && window.getComputedStyle(insideTableCell)["break-inside"] === "avoid") {
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
						range = document.createRange();
						offset = this.textBreak(node, start, end, vStart, vEnd);
						if (!offset) {
							range = undefined;
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

			if (right > end || bottom > vEnd) {
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
