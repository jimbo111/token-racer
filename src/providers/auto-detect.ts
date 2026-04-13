import { ClaudeProvider } from "./claude.ts";
import { CodexProvider } from "./codex.ts";
import { OpenCodeProvider } from "./opencode.ts";
import type { ProviderConfig } from "./provider.ts";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * All known provider configurations, regardless of whether the underlying
 * tool is installed. Add new providers here as they are implemented.
 *
 * Note: running multiple tools concurrently (e.g. invoking `codex` from
 * within a Claude Code session) is a first-class case. Each tool writes to
 * its own log directory and its events are attributed to its own provider
 * via the `provider` field on TokenEvent — no double-counting, no cross-tool
 * dedup collision (dedup key includes provider).
 */
const ALL_PROVIDER_CONFIGS: ProviderConfig[] = [
	{ provider: new ClaudeProvider(), fileFormat: "jsonl" },
	{ provider: new CodexProvider(), fileFormat: "jsonl" },
	{ provider: new OpenCodeProvider(), fileFormat: "json-per-file" },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scans for installed LLM tools and returns only the providers whose log
 * directories are detected on the current system.
 *
 * @returns A (possibly empty) array of ProviderConfig for installed tools.
 */
export async function detectProviders(): Promise<ProviderConfig[]> {
	const results = await Promise.all(
		ALL_PROVIDER_CONFIGS.map(async (config) => {
			const detected = await config.provider.detect();
			return detected ? config : null;
		}),
	);

	return results.filter((config): config is ProviderConfig => config !== null);
}

/**
 * Returns all registered providers regardless of whether they are currently
 * installed on the system. Useful for listing supported tools or for testing.
 */
export function getAllProviders(): ProviderConfig[] {
	return [...ALL_PROVIDER_CONFIGS];
}

// ---------------------------------------------------------------------------
// In-source tests
// ---------------------------------------------------------------------------

if (import.meta.vitest != null) {
	describe("getAllProviders()", () => {
		it("returns at least one provider", () => {
			const configs = getAllProviders();
			expect(configs.length).toBeGreaterThanOrEqual(1);
		});

		it("every entry has a provider with a non-empty name and displayName", () => {
			const configs = getAllProviders();
			for (const config of configs) {
				expect(typeof config.provider.name).toBe("string");
				expect(config.provider.name.length).toBeGreaterThan(0);
				expect(typeof config.provider.displayName).toBe("string");
				expect(config.provider.displayName.length).toBeGreaterThan(0);
			}
		});

		it("every entry has a valid fileFormat", () => {
			const validFormats = new Set(["jsonl", "json-per-file"]);
			for (const config of getAllProviders()) {
				expect(validFormats.has(config.fileFormat)).toBe(true);
			}
		});

		it("includes a provider with name 'claude'", () => {
			const configs = getAllProviders();
			const names = configs.map((c) => c.provider.name);
			expect(names).toContain("claude");
		});

		it("registers all three supported providers (claude, codex, opencode)", () => {
			const names = getAllProviders().map((c) => c.provider.name);
			expect(names).toContain("claude");
			expect(names).toContain("codex");
			expect(names).toContain("opencode");
		});

		it("ClaudeProvider is registered with jsonl fileFormat", () => {
			const configs = getAllProviders();
			const claudeConfig = configs.find((c) => c.provider.name === "claude");
			expect(claudeConfig).toBeDefined();
			expect(claudeConfig?.fileFormat).toBe("jsonl");
		});

		it("CodexProvider is registered with jsonl fileFormat", () => {
			const codexConfig = getAllProviders().find((c) => c.provider.name === "codex");
			expect(codexConfig?.fileFormat).toBe("jsonl");
		});

		it("OpenCodeProvider is registered with json-per-file fileFormat", () => {
			const opencodeConfig = getAllProviders().find((c) => c.provider.name === "opencode");
			expect(opencodeConfig?.fileFormat).toBe("json-per-file");
		});

		it("returns a new array each call (no shared mutable reference)", () => {
			const a = getAllProviders();
			const b = getAllProviders();
			expect(a).not.toBe(b);
			// Contents are structurally equal (same provider instances).
			expect(a.length).toBe(b.length);
		});
	});

	describe("detectProviders()", () => {
		it("returns an array (detected subset may be empty or non-empty)", async () => {
			const configs = await detectProviders();
			expect(Array.isArray(configs)).toBe(true);
		});

		it("every detected provider passes detect() individually", async () => {
			const configs = await detectProviders();
			for (const config of configs) {
				const detected = await config.provider.detect();
				expect(detected).toBe(true);
			}
		});

		it("detected count is at most getAllProviders().length", async () => {
			const detected = await detectProviders();
			const all = getAllProviders();
			expect(detected.length).toBeLessThanOrEqual(all.length);
		});
	});
}
