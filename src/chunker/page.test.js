import Page from "./page.js";

// checkOverflowAfterResize is the only thing that re-checks a page once its
// layout has finished, and it was dead code: the start token was passed as the
// third argument, which is `bounds`, so hasOverflow() compared against
// Math.round(undefined) — NaN — and every comparison came out false. Nothing was
// ever detected, and content that had been pushed into the off-page column (where
// Chromium culls it from the PDF) went unnoticed.
//
// findBreakToken(rendered, source, bounds, prevBreakToken, extract, fallbackNode)
//
// SKIPPED, deliberately: the one-line argument fix is NOT in the tree, because
// enabling this check makes things worse. Measured over all 75 manuals, it takes
// the off-page count 1005 -> 973 but *drops* 232 characters of text in two of
// them (data-reference/message-performance-link-statistics-counters,
// deploy-maintain/probes). The reason is that this method's overflow report is
// what drives Chunker.onOverflow -> stop() / removePages() / resume-from-token,
// and that recovery path has been unreachable for so long that it is itself
// broken. Fix the recovery path first, then apply
// docs/offpage-tools/page-js-argorder-DO-NOT-SHIP-YET.patch in portal-pdftools
// and un-skip this. See docs/offpage-column-content-loss.md §8.
describe.skip("Page.checkOverflowAfterResize", () => {

	function stubPage(returnedToken) {
		let calls = [];
		let page = {
			listening: true,
			wrapper: { name: "wrapper" },
			startToken: { name: "startToken" },
			layoutMethod: {
				findBreakToken(...args) {
					calls.push(args);
					return returnedToken;
				}
			}
		};
		return { page, calls };
	}

	it("does not pass the start token where the bounds belong", () => {
		let { page, calls } = stubPage(undefined);
		let contents = { name: "contents" };

		Page.prototype.checkOverflowAfterResize.call(page, contents);

		expect(calls.length).toEqual(1);
		let [rendered, source, bounds] = calls[0];
		expect(rendered).toBe(page.wrapper);
		expect(source).toBe(contents);
		// The regression: `bounds` must not be a BreakToken. Left undefined it
		// falls back to the layout's own bounds rect.
		expect(bounds).toBeUndefined();
		expect(bounds).not.toBe(page.startToken);
	});

	it("passes the start token as the previous break token", () => {
		let { page, calls } = stubPage(undefined);

		Page.prototype.checkOverflowAfterResize.call(page, { name: "contents" });

		expect(calls[0][3]).toBe(page.startToken);
	});

	it("reports a break token it finds as an overflow", () => {
		let token = { name: "newBreakToken" };
		let { page } = stubPage(token);
		let seen = [];
		page._onOverflow = (t) => seen.push(t);

		Page.prototype.checkOverflowAfterResize.call(page, { name: "contents" });

		expect(page.endToken).toBe(token);
		expect(seen).toEqual([token]);
	});

	it("does nothing once the page has stopped listening", () => {
		let { page, calls } = stubPage(undefined);
		page.listening = false;

		Page.prototype.checkOverflowAfterResize.call(page, { name: "contents" });

		expect(calls.length).toEqual(0);
	});

});
