import { firstFragmentWithText, hasRenderedText } from "./target-counters.js";

// `target-counter(attr(href), page)` is resolved by looking up the element the href
// names and reporting the page it sits on. Only the FIRST fragment of a split element
// keeps its id, and a break-before can leave that fragment behind as an empty stub —
// the element's top edge alone on the previous page, with the heading and everything
// else in the next fragment. Numbering against the stub names the page before the one
// the reader turns to: a table of contents entry off by one.
//
// Observed on eoxdr §8.13, whose section fragmented into 23 pieces. The id-bearing
// piece was 8px tall with no text on page 137; the piece holding the heading was on
// page 138 and had no id.
describe("firstFragmentWithText", () => {

	const build = (html) => {
		const root = document.createElement("div");
		root.innerHTML = html;
		document.body.appendChild(root);
		return root;
	};

	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("skips an empty stub for the fragment that carries the text", () => {
		const root = build(`
			<section id="target" data-ref="r1"></section>
			<section data-ref="r1">Heading and body</section>
		`);
		const stub = root.querySelector("#target");

		const resolved = firstFragmentWithText(stub, root);

		expect(resolved).not.toBe(stub);
		expect(resolved.textContent).toBe("Heading and body");
	});

	it("returns the element itself when it already has text", () => {
		const root = build(`
			<section id="target" data-ref="r1">First page of it</section>
			<section data-ref="r1">continued</section>
		`);
		const first = root.querySelector("#target");

		expect(firstFragmentWithText(first, root)).toBe(first);
	});

	it("returns the element when it was never split", () => {
		const root = build(`
			<section id="target" data-ref="r1"></section>
		`);
		const only = root.querySelector("#target");

		expect(firstFragmentWithText(only, root)).toBe(only);
	});

	// A genuinely empty target — an anchor with nothing in it — must still resolve, or
	// its entry would print no page number at all.
	it("returns the element when no fragment has text", () => {
		const root = build(`
			<a id="target" data-ref="r1"></a>
			<a data-ref="r1"></a>
		`);
		const anchor = root.querySelector("#target");

		expect(firstFragmentWithText(anchor, root)).toBe(anchor);
	});

	// Whitespace-only fragments are what the stub actually looks like: the element's
	// padding, plus whatever whitespace the source had between its tags.
	it("treats a whitespace-only fragment as empty", () => {
		const root = build(`
			<section id="target" data-ref="r1">
			</section>
			<section data-ref="r1">real content</section>
		`);
		const stub = root.querySelector("#target");

		expect(hasRenderedText(stub)).toBe(false);
		expect(firstFragmentWithText(stub, root).textContent).toBe("real content");
	});

	it("picks the FIRST fragment with text, not the last", () => {
		const root = build(`
			<section id="target" data-ref="r1"></section>
			<section data-ref="r1">page two</section>
			<section data-ref="r1">page three</section>
		`);
		const stub = root.querySelector("#target");

		expect(firstFragmentWithText(stub, root).textContent).toBe("page two");
	});

	// The lookup is scoped to the rendered pages: the un-paginated source is still in
	// the document during pagination and must never decide a page number.
	it("only considers fragments inside the given root", () => {
		const pages = build(`
			<section id="target" data-ref="r1"></section>
		`);
		const elsewhere = build(`
			<section data-ref="r1">source copy</section>
		`);
		const stub = pages.querySelector("#target");

		expect(firstFragmentWithText(stub, pages)).toBe(stub);
		expect(elsewhere.textContent.trim()).toBe("source copy");
	});

	it("tolerates a missing element or root", () => {
		const root = build(`
			<section id="target" data-ref="r1"></section>
		`);
		const stub = root.querySelector("#target");

		expect(firstFragmentWithText(null, root)).toBe(null);
		expect(firstFragmentWithText(stub, null)).toBe(stub);
	});
});
