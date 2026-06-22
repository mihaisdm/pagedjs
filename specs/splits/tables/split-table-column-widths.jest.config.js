export default {
	rootDir: ".",
	testMatch: ["**/split-table-column-widths.spec.js"],
	globalSetup: "../../jest_helpers/setup.js",
	globalTeardown: "../../jest_helpers/teardown.js",
	testEnvironment: "../../jest_helpers/puppeteer_environment.js",
	setupFilesAfterEnv: ["./setup_tests_nopdf.js"],
	transform: {
		"\\.js$": ["babel-jest", { configFile: "./babel-jest.config.json" }]
	},
};
