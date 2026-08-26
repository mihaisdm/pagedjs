import { nodeResolve } from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import terser from "@rollup/plugin-terser";
import license from "rollup-plugin-license";
import { execSync } from "child_process";

// Read via createRequire rather than an import attribute: the syntax for those
// changed (`assert` -> `with`) and Node 24 rejects the old spelling outright, so
// a config using either one only builds on some versions of Node. This spelling
// works on all of them.
import { createRequire } from "module";

const pkg = createRequire(import.meta.url)("./package.json");

// Which commit this build came from.
//
// The banner is the only thing that identifies a paged.js build once the file has
// been vendored into another project (portal-pdftools inlines it into every
// generated print page), and the version alone cannot tell one fork build from the
// next. A dirty working copy is marked, so a build made from uncommitted edits is
// never mistaken for the commit it was based on — that distinction cost real time
// when tracking down which build produced a given PDF.
//
// Returns "" when git cannot answer: the container used for the spec suite copies
// the tree without .git (see .dockerignore), and that build must still work.
function buildStamp() {
	const git = (args) => execSync("git " + args, { stdio: ["ignore", "pipe", "ignore"] })
		.toString().trim();
	try {
		const sha = git("rev-parse --short HEAD");
		if (!sha) {
			return "";
		}
		// Ignore untracked files: only a change to tracked source makes this build
		// something other than the commit it claims to be.
		const dirty = git("status --porcelain --untracked-files=no").length > 0;
		return " (" + sha + (dirty ? "-dirty" : "") + ")";
	} catch (error) {
		return "";
	}
}

const BANNER = "@license Paged.js v" + pkg.version + buildStamp()
	+ " | MIT | https://github.com/mihaisdm/pagedjs";

const plugins = [
	nodeResolve({
		extensions: [".cjs",".mjs", ".js"]
	}),
	commonjs({
		include: "node_modules/**"
	}),
	json(),
	license({
		banner: BANNER,
	})
];

export default [
	// browser-friendly UMD build
	{
		input: pkg.main,
		output: {
			name: "Paged",
			file: pkg.browser,
			format: "umd"
		},
		plugins: plugins
	},

	{
		input: pkg.main,
		output: {
			name: "PagedModule",
			file: "./dist/paged.esm.js",
			format: "es"
		},
		plugins: plugins
	},

	{
		input: "./src/polyfill/polyfill.js",
		output: {
			name: "PagedPolyfill",
			file: "./dist/paged.polyfill.js",
			format: "umd"
		},
		plugins: plugins
	},

  // minified 
	{
		input: pkg.main,
		output: {
			name: "PagedModule",
			file: "./dist/paged.min.js",
			format: "umd"
		},
    plugins: [plugins, terser()]
	},
	{
		input: "./src/polyfill/polyfill.js",
		output: {
			name: "PagedPolyfill",
			file: "./dist/paged.polyfill.min.js",
			format: "umd"
		},
		plugins: [plugins, terser()]
	},
];
