import Layout from "./layout.js";
import EventEmitter from "event-emitter";

// How many times a page may be laid out again into a shorter box to keep content
// out of the off-page column. A guard, not an expected count: one shrink is
// normally enough, and a page that is already clean never shrinks at all.
const MAX_OFFPAGE_SHRINKS = 3;

// A copy of `bounds` with `amount` taken off the bottom. Plain object rather than
// a DOMRect because the layout only reads these fields, and DOMRect is readonly.
function shrinkBottom(bounds, amount) {
	return {
		left: bounds.left,
		right: bounds.right,
		top: bounds.top,
		bottom: bounds.bottom - amount,
		width: bounds.width,
		height: bounds.height - amount,
		x: bounds.left,
		y: bounds.top
	};
}

/**
 * Render a page
 * @class
 */
class Page {
	constructor(pagesArea, pageTemplate, blank, hooks, options) {
		this.pagesArea = pagesArea;
		this.pageTemplate = pageTemplate;
		this.blank = blank;

		this.width = undefined;
		this.height = undefined;

		this.hooks = hooks;

		this.settings = options || {};

		// this.element = this.create(this.pageTemplate);
	}

	create(template, after) {
		//let documentFragment = document.createRange().createContextualFragment( TEMPLATE );
		//let page = documentFragment.children[0];
		let clone = document.importNode(this.pageTemplate.content, true);

		let page, index;
		if (after) {
			this.pagesArea.insertBefore(clone, after.nextElementSibling);
			index = Array.prototype.indexOf.call(this.pagesArea.children, after.nextElementSibling);
			page = this.pagesArea.children[index];
		} else {
			this.pagesArea.appendChild(clone);
			page = this.pagesArea.lastChild;
		}

		let pagebox = page.querySelector(".pagedjs_pagebox");
		let area = page.querySelector(".pagedjs_page_content");
		let footnotesArea = page.querySelector(".pagedjs_footnote_area");


		let size = area.getBoundingClientRect();


		area.style.columnWidth = Math.round(size.width) + "px";
		area.style.columnGap = "calc(var(--pagedjs-margin-right) + var(--pagedjs-margin-left) + var(--pagedjs-bleed-right) + var(--pagedjs-bleed-left) + var(--pagedjs-column-gap-offset))";
		// area.style.overflow = "scroll";

		this.width = Math.round(size.width);
		this.height = Math.round(size.height);

		this.element = page;
		this.pagebox = pagebox;
		this.area = area;
		this.footnotesArea = footnotesArea;

		return page;
	}

	createWrapper() {
		let wrapper = document.createElement("div");

		this.area.appendChild(wrapper);

		this.wrapper = wrapper;

		return wrapper;
	}

	index(pgnum) {
		this.position = pgnum;

		let page = this.element;
		// let pagebox = this.pagebox;

		let index = pgnum + 1;

		let id = `page-${index}`;

		this.id = id;

		// page.dataset.pageNumber = index;

		page.dataset.pageNumber = index;
		page.setAttribute("id", id);

		if (this.name) {
			page.classList.add("pagedjs_" + this.name + "_page");
		}

		if (this.blank) {
			page.classList.add("pagedjs_blank_page");
		}

		if (pgnum === 0) {
			page.classList.add("pagedjs_first_page");
		}

		if (pgnum % 2 !== 1) {
			page.classList.remove("pagedjs_left_page");
			page.classList.add("pagedjs_right_page");
		} else {
			page.classList.remove("pagedjs_right_page");
			page.classList.add("pagedjs_left_page");
		}
	}

	/*
	size(width, height) {
		if (width === this.width && height === this.height) {
			return;
		}
		this.width = width;
		this.height = height;

		this.element.style.width = Math.round(width) + "px";
		this.element.style.height = Math.round(height) + "px";
		this.element.style.columnWidth = Math.round(width) + "px";
	}
	*/

	async layout(contents, breakToken, maxChars) {

		this.clear();

		this.startToken = breakToken;

		let settings = this.settings;
		if (!settings.maxChars && maxChars) {
			settings.maxChars = maxChars;
		}

		this.layoutMethod = new Layout(this.area, this.hooks, settings);

		let nextStartToken = breakToken;
		let renderResult;
		let newBreakToken;
		let attempts = 0;

		// Removing the overflow re-fragments the content that stays behind: this
		// page is a multi-column container, so the column break can move up and
		// push content into the off-page column, where it is dropped from the
		// printed output entirely. The break was computed from the layout as it
		// stood *before* the overflow was removed, so it is then wrong, and
		// nothing else re-validates it.
		//
		// Rather than try to repair a page whose DOM has already been mutated —
		// which means re-running break heuristics written for a fresh page, and
		// mapping truncated (and possibly hyphenated) rendered text back to its
		// source — lay the page out again into a slightly shorter box. The
		// existing machinery then simply never places the offending line here,
		// and the content it would have stranded flows to the next page as usual.
		let attemptBounds;
		let shrinks = 0;
		let restored = false;

		do {
			if (attempts > 0) {
				this.clear();
			}

			renderResult = await this.layoutMethod.renderTo(this.wrapper, contents, nextStartToken, attemptBounds);
			newBreakToken = renderResult.breakToken;
			attempts += 1;

			if (!this.hasMeaningfulContent() &&
				newBreakToken &&
				nextStartToken &&
				!newBreakToken.equals(nextStartToken)) {
				nextStartToken = newBreakToken;
				continue;
			}

			let bounds = attemptBounds || this.layoutMethod.bounds;
			let offPage = this.layoutMethod.offPageColumnLines(this.wrapper, bounds);

			if (!offPage.length) {
				break;
			}

			// Take off at least a whole line box, or the retry cannot change which
			// line is placed last.
			if (shrinks < MAX_OFFPAGE_SHRINKS) {
				attemptBounds = shrinkBottom(bounds, Math.max(1, Math.max.apply(null, offPage)));
				shrinks += 1;
				continue;
			}

			// Shrinking never cleared it, so this is content no box on this page can
			// hold (something wider than the page, say). Lay it out once more at the
			// original size, so the page is never paginated worse than it would have
			// been without any of this.
			if (attemptBounds && !restored) {
				attemptBounds = undefined;
				restored = true;
				continue;
			}

			break;
		} while (attempts < 5 + MAX_OFFPAGE_SHRINKS + 1);

		this.addListeners(contents);

		this.endToken = newBreakToken;

		return newBreakToken;
	}

	async append(contents, breakToken) {

		if (!this.layoutMethod) {
			return this.layout(contents, breakToken);
		}

		let renderResult = await this.layoutMethod.renderTo(this.wrapper, contents, breakToken);
		let newBreakToken = renderResult.breakToken;

		this.endToken = newBreakToken;

		return newBreakToken;
	}

	hasMeaningfulContent() {

		if (!this.wrapper) {
			return false;
		}

		if (this.wrapper.textContent && this.wrapper.textContent.trim().length) {
			return true;
		}

		return !!this.wrapper.querySelector("img, svg, canvas, table, video, iframe");
	}

	getByParent(ref, entries) {
		let e;
		for (var i = 0; i < entries.length; i++) {
			e = entries[i];
			if (e.dataset.ref === ref) {
				return e;
			}
		}
	}

	onOverflow(func) {
		this._onOverflow = func;
	}

	onUnderflow(func) {
		this._onUnderflow = func;
	}

	clear() {
		this.removeListeners();
		this.wrapper && this.wrapper.remove();
		this.createWrapper();
	}

	addListeners(contents) {
		if (typeof ResizeObserver !== "undefined") {
			this.addResizeObserver(contents);
		} else {
			this._checkOverflowAfterResize = this.checkOverflowAfterResize.bind(this, contents);
			this.element.addEventListener("overflow", this._checkOverflowAfterResize, false);
			this.element.addEventListener("underflow", this._checkOverflowAfterResize, false);
		}
		// TODO: fall back to mutation observer?

		this._onScroll = function () {
			if (this.listening) {
				this.element.scrollLeft = 0;
			}
		}.bind(this);

		// Keep scroll left from changing
		this.element.addEventListener("scroll", this._onScroll);

		this.listening = true;

		return true;
	}

	removeListeners() {
		this.listening = false;

		if (typeof ResizeObserver !== "undefined" && this.ro) {
			this.ro.disconnect();
		} else if (this.element) {
			this.element.removeEventListener("overflow", this._checkOverflowAfterResize, false);
			this.element.removeEventListener("underflow", this._checkOverflowAfterResize, false);
		}

		this.element && this.element.removeEventListener("scroll", this._onScroll);

	}

	addResizeObserver(contents) {
		let wrapper = this.wrapper;
		let prevHeight = wrapper.getBoundingClientRect().height;
		this.ro = new ResizeObserver(entries => {

			if (!this.listening) {
				return;
			}
			requestAnimationFrame(() => {
				for (let entry of entries) {
					const cr = entry.contentRect;

					if (cr.height > prevHeight) {
						this.checkOverflowAfterResize(contents);
						prevHeight = wrapper.getBoundingClientRect().height;
					} else if (cr.height < prevHeight) { // TODO: calc line height && (prevHeight - cr.height) >= 22
						this.checkUnderflowAfterResize(contents);
						prevHeight = cr.height;
					}
				}
			});
		});

		this.ro.observe(wrapper);
	}

	checkOverflowAfterResize(contents) {
		if (!this.listening || !this.layoutMethod) {
			return;
		}

		let newBreakToken = this.layoutMethod.findBreakToken(this.wrapper, contents, this.startToken);

		if (newBreakToken) {
			this.endToken = newBreakToken;
			this._onOverflow && this._onOverflow(newBreakToken);
		}
	}

	checkUnderflowAfterResize(contents) {
		if (!this.listening || !this.layoutMethod) {
			return;
		}

		let endToken = this.layoutMethod.findEndToken(this.wrapper, contents);

		if (endToken) {
			this._onUnderflow && this._onUnderflow(endToken);
		}
	}


	destroy() {
		this.removeListeners();

		this.element.remove();

		this.element = undefined;
		this.wrapper = undefined;
	}
}

EventEmitter(Page.prototype);


export default Page;
