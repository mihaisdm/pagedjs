import Handler from "../handler.js";
import {attr, querySelectorEscape, UUID} from "../../utils/utils.js";
import csstree from "css-tree";

// How many later pages to wait for a target's content before giving up and numbering
// against the fragment that carries the id. The continuation appears on the very next
// page, so this only needs to cover a target that never renders text at all.
const MAX_TARGET_DEFERRALS = 2;

// Exported for the unit test; nothing outside this module uses them.
export function hasRenderedText(element) {
	return !!element && (element.textContent || "").trim().length > 0;
}

/**
 * The fragment of an element that a reader would actually turn to. Fragments of one
 * source node share a `data-ref`, but only the first keeps the `id`, and that first
 * fragment can be an empty stub left on the previous page — an element's top edge alone,
 * where `break-before` moved its content to the next page.
 *
 * @param {Element} element first fragment, the one carrying the id
 * @param {Element} root the rendered pages, so source nodes are never considered
 * @returns {Element} the first fragment that renders text, or `element` itself when it
 *   is not split or no fragment carries text
 */
export function firstFragmentWithText(element, root) {
	if (!element || hasRenderedText(element)) {
		return element;
	}
	let ref = element.getAttribute && element.getAttribute("data-ref");
	if (!ref || !root) {
		return element;
	}
	let fragments = root.querySelectorAll(`[data-ref="${ref}"]`);
	for (let i = 0; i < fragments.length; i++) {
		if (hasRenderedText(fragments[i])) {
			return fragments[i];
		}
	}
	return element;
}

class TargetCounters extends Handler {
	constructor(chunker, polisher, caller) {
		super(chunker, polisher, caller);

		this.styleSheet = polisher.styleSheet;

		this.counterTargets = {};
	}

	onContent(funcNode, fItem, fList, declaration, rule) {
		if (funcNode.name === "target-counter") {
			let selector = csstree.generate(rule.ruleNode.prelude);

			let first = funcNode.children.first();
			let func = first.name;

			let value = csstree.generate(funcNode);

			let args = [];

			first.children.forEach((child) => {
				if (child.type === "Identifier") {

					args.push(child.name);
				}
			});

			let counter;
			let style;
			let styleIdentifier;

			funcNode.children.forEach((child) => {
				if (child.type === "Identifier") {
					if (!counter) {
						counter = child.name;
					} else if (!style) {
						styleIdentifier = csstree.clone(child);
						style = child.name;
					}
				}
			});

			let variable = "target-counter-" + UUID();

			selector.split(",").forEach((s) => {
				this.counterTargets[s] = {
					func: func,
					args: args,
					value: value,
					counter: counter,
					style: style,
					selector: s,
					fullSelector: selector,
					variable: variable
				};
			});

			// Replace with counter
			funcNode.name = "counter";
			funcNode.children = new csstree.List();
			funcNode.children.appendData({
				type: "Identifier",
				loc: 0,
				name: variable
			});

			if (styleIdentifier) {
				funcNode.children.appendData({type: "Operator", loc: null, value: ","});
				funcNode.children.appendData(styleIdentifier);
			}
		}
	}

	afterPageLayout(fragment, page, breakToken, chunker) {
		Object.keys(this.counterTargets).forEach((name) => {
			let target = this.counterTargets[name];
			let split = target.selector.split(/::?/g);
			let query = split[0];

			let queried = chunker.pagesArea.querySelectorAll(query + ":not([data-" + target.variable + "])");

			queried.forEach((selected, index) => {
				// TODO: handle func other than attr
				if (target.func !== "attr") {
					return;
				}
				let val = attr(selected, target.args);
				let element = chunker.pagesArea.querySelector(querySelectorEscape(val));

				let resolveAgainst = firstFragmentWithText(element, chunker.pagesArea);

				if (element && !hasRenderedText(resolveAgainst)) {
					// Nothing of the target has rendered yet. Only the first fragment of a
					// split element keeps the id, and a break-before leaves that fragment
					// behind as an empty stub, so numbering against it names the page
					// before the one the reader turns to. The continuation does not exist
					// on this pass — the split marker is not even set yet — so leave the
					// target unresolved; the query above retries it after every later page.
					let deferrals = "data-" + target.variable + "-deferred";
					let tries = parseInt(selected.getAttribute(deferrals) || "0", 10) + 1;
					if (tries <= MAX_TARGET_DEFERRALS) {
						selected.setAttribute(deferrals, String(tries));
						return;
					}
					// Out of patience: a target that never renders text still needs a number.
				}

				element = resolveAgainst;

				if (element) {
					let selector = UUID();
					selected.setAttribute("data-" + target.variable, selector);
					// TODO: handle other counter types (by query)
					let pseudo = "";
					if (split.length > 1) {
						pseudo += "::" + split[1];
					}
					if (target.counter === "page") {
						let pages = chunker.pagesArea.querySelectorAll(".pagedjs_page");
						let pg = 0;
						for (let i = 0; i < pages.length; i++) {
							let page = pages[i];
							let styles = window.getComputedStyle(page);
							let reset = styles["counter-reset"].replace("page", "").trim();
							let increment = styles["counter-increment"].replace("page", "").trim();

							if (reset !== "none") {
								pg = parseInt(reset);
							}
							if (increment !== "none") {
								pg += parseInt(increment);
							}

							if (page.contains(element)){
								break;
							}
						}
						this.styleSheet.insertRule(`[data-${target.variable}="${selector}"]${pseudo} { counter-reset: ${target.variable} ${pg}; }`, this.styleSheet.cssRules.length);
					} else {
						let value = element.getAttribute(`data-counter-${target.counter}-value`);
						if (value) {
							this.styleSheet.insertRule(`[data-${target.variable}="${selector}"]${pseudo} { counter-reset: ${target.variable} ${target.variable} ${parseInt(value)}; }`, this.styleSheet.cssRules.length);
						}
					}

					// force redraw
					let el = document.querySelector(`[data-${target.variable}="${selector}"]`);
					if (el) {
						el.style.display = "none";
						el.clientHeight;
						el.style.removeProperty("display");
					}
				}
			});
		});
	}
}

export default TargetCounters;
