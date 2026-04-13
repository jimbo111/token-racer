import { accessSync, constants } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { define } from "gunshi";
import pc from "picocolors";
import {
	CLAUDE_SETTINGS_PATH,
	STATUSLINE_COMMAND,
} from "../installer/claude-settings.ts";
import {
	detectShell,
	hasBlock,
	rcPathForShell,
} from "../installer/shell-rc.ts";
import { KEYS_DIR, LAST_SYNC_FILE } from "../constants.ts";
import { loadConfig } from "../setup.ts";
import { detectProviders } from "../providers/auto-detect.ts";
import type { DaemonConfig } from "../types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CheckResult = {
	name: string;
	ok: boolean;
	summary: string;
	details?: Record<string, unknown>;
};

type DoctorReport = {
	ok: boolean;
	checks: CheckResult[];
};

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

/** Require Node ≥ 22 (what the CLI is developed + bundled against). */
export function checkNode(): CheckResult {
	const version = process.version; // e.g. "v22.12.0"
	const majorRaw = version.replace(/^v/, "").split(".")[0] ?? "0";
	const major = Number.parseInt(majorRaw, 10);
	const ok = Number.isFinite(major) && major >= 22;
	return {
		name: "node",
		ok,
		summary: ok ? version : `${version} (need ≥ v22)`,
		details: { version, major },
	};
}

/**
 * Scans $PATH for an executable named `token-racer`. Pure Node — no subprocess,
 * no shell. Good proxy for "will the rc block's `command -v` guard resolve?"
 * since we run under the same PATH inherited from the invoking shell.
 */
export function checkBinaryOnPath(): CheckResult {
	const pathEnv = process.env["PATH"] ?? "";
	const sep = process.platform === "win32" ? ";" : ":";
	const dirs = pathEnv.split(sep).filter((d) => d !== "");
	// On Windows look for the common wrappers; on POSIX it's just `token-racer`.
	const candidates =
		process.platform === "win32"
			? ["token-racer.cmd", "token-racer.exe", "token-racer"]
			: ["token-racer"];

	for (const dir of dirs) {
		for (const name of candidates) {
			const candidate = path.join(dir, name);
			try {
				accessSync(candidate, constants.X_OK);
				return {
					name: "binaryOnPath",
					ok: true,
					summary: `resolved to ${candidate}`,
					details: { path: candidate },
				};
			} catch {
				// Not there or not executable — keep scanning.
			}
		}
	}

	return {
		name: "binaryOnPath",
		ok: false,
		summary:
			"token-racer NOT on PATH — shell integration will no-op. Symlink the binary into ~/.local/bin or /usr/local/bin.",
	};
}

async function checkKeypair(): Promise<CheckResult> {
	const publicPath = path.join(KEYS_DIR, "public.pem");
	const privatePath = path.join(KEYS_DIR, "private.pem");
	try {
		const [, privStat] = await Promise.all([stat(publicPath), stat(privatePath)]);
		const mode = privStat.mode & 0o777;
		const modeOk = mode === 0o600;
		return {
			name: "keypair",
			ok: modeOk,
			summary: modeOk
				? `Ed25519 keys present (private.pem mode 0${mode.toString(8)})`
				: `private.pem mode is 0${mode.toString(8)} — should be 0600. Fix: chmod 600 ${privatePath}`,
			details: {
				publicPath,
				privatePath,
				mode: `0${mode.toString(8)}`,
			},
		};
	} catch {
		return {
			name: "keypair",
			ok: false,
			summary: "No keypair — run `token-racer auth init`",
			details: { keysDir: KEYS_DIR },
		};
	}
}

export function checkConfig(config: DaemonConfig | null): CheckResult {
	if (config === null) {
		return {
			name: "config",
			ok: false,
			summary: "No config.json — run `token-racer auth register`",
		};
	}
	const hasApiKey = typeof config.apiKey === "string" && config.apiKey !== "";
	const hasUserId = typeof config.userId === "string" && config.userId !== "";
	if (!hasApiKey || !hasUserId) {
		return {
			name: "config",
			ok: false,
			summary:
				"config.json present but missing apiKey / userId — re-run `token-racer auth register`",
			details: { hasApiKey, hasUserId },
		};
	}
	return {
		name: "config",
		ok: true,
		summary: `Registered as ${config.username ?? "(unnamed)"} at ${config.apiUrl}`,
		details: {
			userId: config.userId,
			username: config.username,
			apiUrl: config.apiUrl,
		},
	};
}

async function checkBackend(config: DaemonConfig | null): Promise<CheckResult> {
	const apiUrl = config?.apiUrl;
	if (typeof apiUrl !== "string" || apiUrl === "") {
		return {
			name: "backend",
			ok: false,
			summary: "No backend URL configured",
		};
	}
	const url = `${apiUrl.replace(/\/$/, "")}/health`;
	const start = Date.now();
	try {
		const res = await fetch(url, {
			method: "GET",
			signal: AbortSignal.timeout(5_000),
		});
		const latencyMs = Date.now() - start;
		const ok = res.ok;
		return {
			name: "backend",
			ok,
			summary: ok
				? `${apiUrl} reachable (${latencyMs}ms)`
				: `${apiUrl} returned HTTP ${res.status} (${latencyMs}ms)`,
			details: { url, status: res.status, latencyMs },
		};
	} catch (err) {
		return {
			name: "backend",
			ok: false,
			summary: `${apiUrl} unreachable — ${err instanceof Error ? err.message : String(err)}`,
			details: { url },
		};
	}
}

async function checkProviders(): Promise<CheckResult> {
	try {
		const detected = await detectProviders();
		const names = detected.map((c) => c.provider.name);
		const ok = detected.length > 0;
		return {
			name: "providers",
			ok,
			summary: ok
				? `${detected.length} detected: ${names.join(", ")}`
				: "no LLM tools detected — install Claude Code, Codex, or OpenCode",
			details: { detected: names },
		};
	} catch (err) {
		return {
			name: "providers",
			ok: false,
			summary: `detection failed — ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

/**
 * `last-sync.json` is advisory. "Never synced" is OK (just-registered users).
 * A recorded error IS a failure — surface it so the user can act.
 */
async function checkLastSync(): Promise<CheckResult> {
	try {
		const raw = await readFile(LAST_SYNC_FILE, "utf8");
		const data = JSON.parse(raw) as {
			at: string;
			accepted: number;
			error?: string;
		};
		const ageMs = Date.now() - new Date(data.at).getTime();
		if (data.error !== undefined) {
			return {
				name: "lastSync",
				ok: false,
				summary: `failed ${formatAge(ageMs)} ago: ${data.error}`,
				details: { ...data, ageMs },
			};
		}
		return {
			name: "lastSync",
			ok: true,
			summary: `succeeded ${formatAge(ageMs)} ago (${data.accepted} event${data.accepted === 1 ? "" : "s"})`,
			details: { ...data, ageMs },
		};
	} catch {
		return {
			name: "lastSync",
			ok: true,
			summary: "never synced yet",
		};
	}
}

async function checkClaudeStatusLine(): Promise<CheckResult> {
	let raw: string;
	try {
		raw = await readFile(CLAUDE_SETTINGS_PATH, "utf8");
	} catch {
		return {
			name: "claudeStatusLine",
			ok: false,
			summary: `${CLAUDE_SETTINGS_PATH} absent — run \`token-racer install\``,
		};
	}
	if (raw.trim() === "") {
		return {
			name: "claudeStatusLine",
			ok: false,
			summary: "settings.json is empty — run `token-racer install`",
		};
	}
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch (err) {
		return {
			name: "claudeStatusLine",
			ok: false,
			summary: `settings.json malformed — ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	const isRecord = (v: unknown): v is Record<string, unknown> =>
		typeof v === "object" && v !== null && !Array.isArray(v);
	if (!isRecord(data)) {
		return {
			name: "claudeStatusLine",
			ok: false,
			summary: "settings.json is not an object",
		};
	}
	const sl = data["statusLine"];
	if (sl === undefined) {
		return {
			name: "claudeStatusLine",
			ok: false,
			summary: "no statusLine entry — run `token-racer install`",
		};
	}
	if (!isRecord(sl)) {
		return {
			name: "claudeStatusLine",
			ok: false,
			summary: "statusLine entry malformed",
		};
	}
	const cmd = sl["command"];
	if (typeof cmd !== "string") {
		return {
			name: "claudeStatusLine",
			ok: false,
			summary: "statusLine has no command",
		};
	}
	const ok =
		cmd === STATUSLINE_COMMAND || cmd.startsWith(`${STATUSLINE_COMMAND} `);
	return {
		name: "claudeStatusLine",
		ok,
		summary: ok
			? "registered"
			: `statusLine points at another command: ${cmd}`,
		details: { command: cmd },
	};
}

async function checkShellRc(): Promise<CheckResult> {
	const shell = detectShell();
	if (shell === null) {
		return {
			name: "shellRc",
			ok: false,
			summary: `unsupported shell: ${process.env["SHELL"] ?? "(unset)"}`,
		};
	}
	const rcPath = rcPathForShell(shell);
	let content: string;
	try {
		content = await readFile(rcPath, "utf8");
	} catch {
		return {
			name: "shellRc",
			ok: false,
			summary: `${rcPath} absent — run \`token-racer install\``,
			details: { rcPath, shell },
		};
	}
	const installed = hasBlock(content);
	return {
		name: "shellRc",
		ok: installed,
		summary: installed
			? `block present in ${rcPath} (${shell})`
			: `no block in ${rcPath} — run \`token-racer install\``,
		details: { rcPath, shell },
	};
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function runAllChecks(): Promise<DoctorReport> {
	const config = await loadConfig();

	const checks: CheckResult[] = await Promise.all([
		Promise.resolve(checkNode()),
		Promise.resolve(checkBinaryOnPath()),
		checkKeypair(),
		Promise.resolve(checkConfig(config)),
		checkBackend(config),
		checkProviders(),
		checkLastSync(),
		checkClaudeStatusLine(),
		checkShellRc(),
	]);

	return {
		ok: checks.every((c) => c.ok),
		checks,
	};
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderText(report: DoctorReport): string {
	const lines: string[] = [];
	lines.push("");
	lines.push(`  ${pc.bold("token-racer")} doctor`);
	lines.push(`  ${"─".repeat(40)}`);
	for (const c of report.checks) {
		const symbol = c.ok ? pc.green("✓") : pc.red("✗");
		const label = formatLabel(c.name).padEnd(20);
		lines.push(`  ${symbol} ${label} ${c.summary}`);
	}
	lines.push("");
	lines.push(
		report.ok
			? `  ${pc.green("All checks passed.")}`
			: `  ${pc.red("Issues detected — see above.")}`,
	);
	lines.push("");
	return lines.join("\n");
}

function renderJson(report: DoctorReport): string {
	return JSON.stringify(report, null, 2);
}

export function formatLabel(name: string): string {
	const map: Record<string, string> = {
		node: "Node runtime",
		binaryOnPath: "Binary on PATH",
		keypair: "Keypair",
		config: "Config",
		backend: "Backend",
		providers: "Providers",
		lastSync: "Last sync",
		claudeStatusLine: "Claude statusLine",
		shellRc: "Shell rc",
	};
	return map[name] ?? name;
}

function formatAge(ms: number): string {
	if (ms < 0) return "just now";
	const s = Math.floor(ms / 1000);
	if (s < 2) return "just now";
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	const d = Math.floor(h / 24);
	return `${d}d`;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

const doctorCommand = define({
	name: "doctor",
	description:
		"Run health checks across local state, backend connectivity, and shell integration. Exits 1 if anything fails.",
	args: {
		json: {
			type: "boolean",
			short: "j",
			description: "Emit structured JSON instead of human-readable text.",
			default: false,
		},
	},
	async run(ctx) {
		const report = await runAllChecks();
		if (ctx.values.json === true) {
			process.stdout.write(renderJson(report) + "\n");
		} else {
			process.stdout.write(renderText(report));
		}
		if (!report.ok) {
			process.exitCode = 1;
		}
	},
});

export default doctorCommand;

// ---------------------------------------------------------------------------
// In-source tests
// ---------------------------------------------------------------------------

if (import.meta.vitest != null) {
	describe("checkNode", () => {
		it("reports ok for the running Node process (tests require ≥ 22)", () => {
			const r = checkNode();
			expect(r.name).toBe("node");
			expect(r.ok).toBe(true);
			expect(r.summary).toContain(process.version);
			expect(r.details?.version).toBe(process.version);
		});
	});

	describe("checkConfig", () => {
		it("fails when config is null", () => {
			const r = checkConfig(null);
			expect(r.ok).toBe(false);
			expect(r.summary).toContain("auth register");
		});

		it("fails when apiKey is missing", () => {
			const r = checkConfig({ apiUrl: "http://x" } as DaemonConfig);
			expect(r.ok).toBe(false);
			expect(r.summary).toContain("missing apiKey");
		});

		it("passes when apiKey + userId + apiUrl are present", () => {
			const r = checkConfig({
				apiUrl: "http://x",
				apiKey: "k",
				userId: "u",
				username: "racer-1",
			});
			expect(r.ok).toBe(true);
			expect(r.summary).toContain("racer-1");
		});
	});

	describe("checkBinaryOnPath", () => {
		it("returns a sensible shape regardless of environment", () => {
			const r = checkBinaryOnPath();
			expect(r.name).toBe("binaryOnPath");
			expect(typeof r.ok).toBe("boolean");
			expect(typeof r.summary).toBe("string");
			expect(r.summary.length).toBeGreaterThan(0);
		});
	});

	describe("formatLabel", () => {
		it("maps known check names to display labels", () => {
			expect(formatLabel("node")).toBe("Node runtime");
			expect(formatLabel("binaryOnPath")).toBe("Binary on PATH");
			expect(formatLabel("shellRc")).toBe("Shell rc");
		});

		it("returns the raw name for unknown keys", () => {
			expect(formatLabel("somethingNew")).toBe("somethingNew");
		});
	});

	describe("renderText", () => {
		it("includes the header and a per-check line for every result", () => {
			const report: DoctorReport = {
				ok: true,
				checks: [
					{ name: "node", ok: true, summary: "v22.12.0" },
					{ name: "shellRc", ok: true, summary: "installed" },
				],
			};
			const out = renderText(report);
			expect(out).toContain("token-racer");
			expect(out).toContain("Node runtime");
			expect(out).toContain("Shell rc");
			expect(out).toContain("All checks passed.");
		});

		it("shows an issues-detected footer when any check fails", () => {
			const report: DoctorReport = {
				ok: false,
				checks: [{ name: "node", ok: false, summary: "too old" }],
			};
			expect(renderText(report)).toContain("Issues detected");
		});
	});
}
