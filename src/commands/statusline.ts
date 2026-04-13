import { spawn } from "node:child_process";
import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { define } from "gunshi";
import pc from "picocolors";
import { detectProviders } from "../providers/auto-detect.ts";
import { getAllProviders } from "../providers/auto-detect.ts";
import type { ProviderConfig } from "../providers/provider.ts";
import type { TokenEvent } from "../types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cache TTL in milliseconds (5 seconds). */
const CACHE_TTL_MS = 5_000;

/** Path for the statusline result cache. */
const CACHE_FILE = path.join(os.tmpdir(), "token-racer-statusline.json");

/** How often we're willing to fire a background sync from statusline. */
const BACKGROUND_SYNC_MIN_INTERVAL_MS = 15_000;

/** Path where we record the timestamp of the last background sync we spawned. */
const LAST_BG_SYNC_FILE = path.join(os.tmpdir(), "token-racer-last-bg-sync");

// ---------------------------------------------------------------------------
// Formatting helpers (exported for in-source tests)
// ---------------------------------------------------------------------------

/**
 * Formats a raw token count into a human-readable abbreviated string.
 *
 * - < 1 000            → raw number, e.g. "847"
 * - 1 000 – 999 999    → "123K"
 * - ≥ 1 000 000        → "1.2M"
 */
export function formatTokens(n: number): string {
	if (n < 1_000) return String(n);
	if (n < 1_000_000) return `${Math.round(n / 1_000)}K`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Formats a USD amount as "$X.XX", always showing two decimal places.
 */
export function formatCost(usd: number): string {
	return `$${usd.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function localDateString(): string {
	const now = new Date();
	const yyyy = now.getFullYear();
	const mm = String(now.getMonth() + 1).padStart(2, "0");
	const dd = String(now.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

function isToday(timestamp: string, todayStr: string): boolean {
	try {
		const d = new Date(timestamp);
		if (isNaN(d.getTime())) return false;
		const yyyy = d.getFullYear();
		const mm = String(d.getMonth() + 1).padStart(2, "0");
		const dd = String(d.getDate()).padStart(2, "0");
		return `${yyyy}-${mm}-${dd}` === todayStr;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

async function findFilesByExtension(dir: string, ext: string): Promise<string[]> {
	try {
		const entries = await readdir(dir, { recursive: true, withFileTypes: true });
		const results: string[] = [];
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			if (!entry.name.endsWith(ext)) continue;
			const parent =
				(entry as typeof entry & { parentPath?: string }).parentPath ??
				(entry as typeof entry & { path?: string }).path ??
				dir;
			results.push(path.join(parent, entry.name));
		}
		return results;
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Per-provider token aggregation
// ---------------------------------------------------------------------------

type ProviderUsage = {
	displayName: string;
	tokens: number;
	cost: number;
};

async function aggregateProvider(
	config: ProviderConfig,
	todayStr: string,
): Promise<ProviderUsage> {
	const { provider, fileFormat } = config;
	const logDirs = provider.getLogDirs();
	const pattern = provider.getFilePattern();
	const ext = path.extname(pattern);

	let totalTokens = 0;
	let totalCost = 0;

	for (const logDir of logDirs) {
		const files = await findFilesByExtension(logDir, ext);

		for (const filePath of files) {
			try {
				const s = await stat(filePath);
				const mtimeDate = new Date(s.mtimeMs);
				const mtimeDay = `${mtimeDate.getFullYear()}-${String(mtimeDate.getMonth() + 1).padStart(2, "0")}-${String(mtimeDate.getDate()).padStart(2, "0")}`;
				if (mtimeDay < todayStr) continue;
			} catch {
				continue;
			}

			let raw: string;
			try {
				raw = await readFile(filePath, "utf8");
			} catch {
				continue;
			}

			const context = {
				filePath,
				projectName: path.basename(path.dirname(filePath)),
				fileSessionId: path.basename(filePath, path.extname(filePath)),
			};

			let events: TokenEvent[];

			if (fileFormat === "jsonl") {
				events = raw
					.split("\n")
					.flatMap((line) => {
						const trimmed = line.trim();
						if (trimmed === "") return [];
						return provider.parseEntry(trimmed, context);
					});
			} else {
				events = provider.parseEntry(raw, context);
			}

			for (const event of events) {
				if (!isToday(event.timestamp, todayStr)) continue;
				totalTokens += event.inputTokens + event.outputTokens;
				totalCost += event.costUsd ?? 0;
			}
		}
	}

	return {
		displayName: provider.displayName,
		tokens: totalTokens,
		cost: totalCost,
	};
}

// ---------------------------------------------------------------------------
// Background sync trigger
// ---------------------------------------------------------------------------

/**
 * Fires `token-racer sync` in a fully-detached child process if we haven't
 * done so within BACKGROUND_SYNC_MIN_INTERVAL_MS. Never blocks the statusline.
 *
 * The child runs with `stdio: "ignore"` and `.unref()` so it outlives the
 * statusline invocation but doesn't keep the parent alive while it waits.
 */
async function maybeTriggerBackgroundSync(): Promise<void> {
	try {
		let shouldSpawn = true;
		try {
			const raw = await readFile(LAST_BG_SYNC_FILE, "utf8");
			const lastMs = parseInt(raw, 10);
			if (Number.isFinite(lastMs) && Date.now() - lastMs < BACKGROUND_SYNC_MIN_INTERVAL_MS) {
				shouldSpawn = false;
			}
		} catch {
			// File missing or unreadable — treat as never synced.
		}

		if (!shouldSpawn) return;

		// Record the attempt BEFORE spawning, so concurrent statuslines don't
		// all fire their own sync at once. The rate limit is best-effort.
		await writeFile(LAST_BG_SYNC_FILE, String(Date.now()), "utf8").catch(() => undefined);

		// argv[0] is the Node binary, argv[1] is our entry script. We re-invoke
		// the same entry with a fresh `sync --quiet` argv.
		const node = process.argv[0];
		const script = process.argv[1];
		if (typeof node !== "string" || typeof script !== "string") return;
		const child = spawn(node, [script, "sync", "--quiet"], {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
		child.unref();
	} catch {
		// Any failure here is silent — the statusline must not be blocked.
	}
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

type CachedResult = {
	ts: number;
	output: string;
	jsonOutput: StatuslineJson;
};

async function readCache(): Promise<CachedResult | null> {
	try {
		const raw = await readFile(CACHE_FILE, "utf8");
		const data = JSON.parse(raw) as CachedResult;
		if (Date.now() - data.ts <= CACHE_TTL_MS) return data;
		return null;
	} catch {
		return null;
	}
}

async function writeCache(result: CachedResult): Promise<void> {
	try {
		await mkdir(path.dirname(CACHE_FILE), { recursive: true });
		await writeFile(CACHE_FILE, JSON.stringify(result), "utf8");
	} catch {
		// Cache write failures are silently ignored.
	}
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

type ProviderJson = {
	name: string;
	tokens: number;
	cost: number;
};

type StatuslineJson = {
	date: string;
	totalTokens: number;
	totalCost: number;
	providersDetected: number;
	providers: ProviderJson[];
	hasUsage: boolean;
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderPlain(
	usages: ProviderUsage[],
	totalTokens: number,
	totalCost: number,
	todayStr: string,
): string {
	const hasUsage = totalTokens > 0;
	const providerCount = usages.length;

	if (!hasUsage) {
		return `No usage today · ${providerCount} provider${providerCount !== 1 ? "s" : ""} detected`;
	}

	const providerParts = usages
		.filter((u) => u.tokens > 0)
		.map((u) => `${u.displayName} > ${formatTokens(u.tokens)}`);

	const parts: string[] = [
		`Today (${todayStr}): ${formatTokens(totalTokens)} tokens · ${formatCost(totalCost)}`,
	];

	if (providerParts.length > 0) {
		parts.push(providerParts.join(" · "));
	}

	return parts.join(" · ");
}

function renderStyled(
	usages: ProviderUsage[],
	totalTokens: number,
	totalCost: number,
): string {
	const hasUsage = totalTokens > 0;
	const providerCount = usages.length;

	if (!hasUsage) {
		return (
			`💤 ${pc.dim("No usage today")} · ` +
			pc.dim(`${providerCount} provider${providerCount !== 1 ? "s" : ""} detected`)
		);
	}

	const providerParts = usages
		.filter((u) => u.tokens > 0)
		.map((u) => `${pc.dim(u.displayName)} ${pc.bold("▸")} ${pc.bold(formatTokens(u.tokens))}`);

	const summaryParts: string[] = [
		`🔥 ${pc.dim("Today:")} ${pc.bold(formatTokens(totalTokens))} ${pc.dim("tokens")} · ${pc.bold(formatCost(totalCost))}`,
	];

	if (providerParts.length > 0) {
		summaryParts.push(...providerParts);
	}

	return summaryParts.join(pc.dim(" · "));
}

// ---------------------------------------------------------------------------
// Command implementation
// ---------------------------------------------------------------------------

const statuslineCommand = define({
	name: "statusline",
	description: "Output a compact one-line usage summary for shell prompt embedding",
	args: {
		plain: {
			type: "boolean",
			short: "p",
			description: "Disable colors and emoji (for non-interactive shells)",
			default: false,
		},
		json: {
			type: "boolean",
			short: "j",
			description: "Output as JSON instead of styled text",
			default: false,
		},
		"no-sync": {
			type: "boolean",
			description: "Don't trigger a background sync on this invocation (diagnostics only)",
			default: false,
		},
	},
	async run(ctx) {
		// Fire the background sync FIRST so it runs in parallel with our rendering.
		// Never await it — it's fully detached.
		if (ctx.values["no-sync"] !== true) {
			void maybeTriggerBackgroundSync();
		}

		// Never let statusline crash the shell prompt.
		try {
			await runStatusline(ctx.values.plain, ctx.values.json);
		} catch {
			// Last-resort fallback: emit a minimal non-throwing line.
			const fallback = ctx.values.json
				? '{"error":"statusline failed","totalTokens":0,"totalCost":0}'
				: ctx.values.plain
					? "token-racer: unavailable"
					: pc.dim("token-racer: unavailable");
			process.stdout.write(fallback + "\n");
		}
	},
});

async function runStatusline(plain: boolean, json: boolean): Promise<void> {
	const todayStr = localDateString();

	// Fast path: serve from cache if still valid.
	const cached = await readCache();
	if (cached != null) {
		if (json) {
			process.stdout.write(JSON.stringify(cached.jsonOutput) + "\n");
		} else if (plain) {
			const j = cached.jsonOutput;
			const usages: ProviderUsage[] = j.providers.map((p) => ({
				displayName: p.name,
				tokens: p.tokens,
				cost: p.cost,
			}));
			process.stdout.write(
				renderPlain(usages, j.totalTokens, j.totalCost, j.date) + "\n",
			);
		} else {
			process.stdout.write(cached.output + "\n");
		}
		return;
	}

	const [detectedConfigs, allProviders] = await Promise.all([
		detectProviders().catch((): ProviderConfig[] => []),
		Promise.resolve(getAllProviders()),
	]);

	const usages = await Promise.all(
		detectedConfigs.map((config) => aggregateProvider(config, todayStr)),
	);

	const totalTokens = usages.reduce((acc, u) => acc + u.tokens, 0);
	const totalCost = usages.reduce((acc, u) => acc + u.cost, 0);

	const styledOutput = renderStyled(usages, totalTokens, totalCost);

	const jsonOutput: StatuslineJson = {
		date: todayStr,
		totalTokens,
		totalCost,
		providersDetected: detectedConfigs.length,
		providers: usages.map((u) => ({
			name: u.displayName,
			tokens: u.tokens,
			cost: u.cost,
		})),
		hasUsage: totalTokens > 0,
	};

	void writeCache({ ts: Date.now(), output: styledOutput, jsonOutput });

	if (json) {
		process.stdout.write(JSON.stringify(jsonOutput) + "\n");
		return;
	}

	if (plain) {
		void allProviders;
		process.stdout.write(
			renderPlain(usages, totalTokens, totalCost, todayStr) + "\n",
		);
		return;
	}

	process.stdout.write(styledOutput + "\n");
}

export default statuslineCommand;

// ---------------------------------------------------------------------------
// In-source tests
// ---------------------------------------------------------------------------

if (import.meta.vitest != null) {
	describe("formatTokens", () => {
		it("returns raw number for values under 1000", () => {
			expect(formatTokens(0)).toBe("0");
			expect(formatTokens(1)).toBe("1");
			expect(formatTokens(999)).toBe("999");
		});

		it("formats 1000–999999 as K with rounding", () => {
			expect(formatTokens(1_000)).toBe("1K");
			expect(formatTokens(1_499)).toBe("1K");
			expect(formatTokens(1_500)).toBe("2K");
			expect(formatTokens(123_456)).toBe("123K");
			expect(formatTokens(999_999)).toBe("1000K");
		});

		it("formats 1 000 000+ as M with one decimal place", () => {
			expect(formatTokens(1_000_000)).toBe("1.0M");
			expect(formatTokens(1_200_000)).toBe("1.2M");
			expect(formatTokens(2_500_000)).toBe("2.5M");
		});
	});

	describe("formatCost", () => {
		it("formats zero cost as $0.00", () => {
			expect(formatCost(0)).toBe("$0.00");
		});

		it("formats small amounts with two decimal places", () => {
			expect(formatCost(0.1)).toBe("$0.10");
			expect(formatCost(4.23)).toBe("$4.23");
		});

		it("formats large amounts correctly", () => {
			expect(formatCost(100)).toBe("$100.00");
			expect(formatCost(1234.5)).toBe("$1234.50");
		});

		it("rounds to two decimal places", () => {
			expect(formatCost(1.234)).toBe("$1.23");
			expect(formatCost(1.235)).toBe("$1.24");
		});
	});
}
