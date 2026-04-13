import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["./src/index.ts"],
	outDir: "dist",
	format: "esm",
	clean: true,
	define: {
		"import.meta.vitest": "undefined",
	},
	banner: {
		js: "#!/usr/bin/env node",
	},
});
