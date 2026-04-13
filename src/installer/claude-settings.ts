import { mkdir, readFile, writeFile, rename, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
export const STATUSLINE_COMMAND = "token-racer statusline";

export type ClaudeInstallResult =
	| { kind: "installed"; previousStatusLine: null }
	| { kind: "already-installed" }
	| { kind: "conflict"; existing: unknown; hint: string }
	| { kind: "malformed-settings"; hint: string }
	| { kind: "error"; message: string };

export type ClaudeUninstallResult =
	| { kind: "removed" }
	| { kind: "not-installed"; reason: string }
	| { kind: "foreign"; existing: unknown; hint: string }
	| { kind: "malformed-settings"; hint: string }
	| { kind: "error"; message: string };

/**
 * Merges a statusLine entry into ~/.claude/settings.json so Claude Code will
 * invoke `token-racer statusline` on each render.
 *
 * Safety properties:
 *   - Idempotent: re-running returns `already-installed` without rewriting.
 *   - Non-destructive: if `statusLine` is already set to something else, we
 *     return `conflict` and leave the file untouched (unless `force`).
 *   - Atomic write: temp file + rename, so a crash mid-write cannot corrupt.
 *   - Backup: a `.bak-{ts}` copy is made before any write.
 *
 * Creates the `~/.claude/` directory if it doesn't exist (Claude Code hasn't
 * run yet) — the next Claude Code launch will use our settings.
 */
export async function installClaudeSettings(opts: { force?: boolean } = {}): Promise<ClaudeInstallResult> {
	const ourEntry = { type: "command" as const, command: STATUSLINE_COMMAND };

	try {
		await mkdir(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
	} catch (err) {
		return {
			kind: "error",
			message: `Could not create ${path.dirname(CLAUDE_SETTINGS_PATH)}: ${errorMessage(err)}`,
		};
	}

	// Load existing settings. Four possibilities: missing, empty, valid JSON, malformed.
	const existing = await readSettings();
	if (existing.kind === "malformed") {
		return {
			kind: "malformed-settings",
			hint: `~/.claude/settings.json is not valid JSON. Fix it manually, then re-run install. Parse error: ${existing.reason}`,
		};
	}

	const current = existing.kind === "present" ? existing.data : {};
	const currentStatusLine = isRecord(current) ? current["statusLine"] : undefined;

	if (statusLineMatchesOurs(currentStatusLine)) {
		return { kind: "already-installed" };
	}

	if (currentStatusLine !== undefined && !opts.force) {
		return {
			kind: "conflict",
			existing: currentStatusLine,
			hint: "Another statusLine is already configured. Re-run with --force to overwrite it, or remove it manually.",
		};
	}

	const merged: Record<string, unknown> = {
		...(isRecord(current) ? current : {}),
		statusLine: ourEntry,
	};

	try {
		await backupIfPresent(CLAUDE_SETTINGS_PATH);
	} catch {
		// Backup failure shouldn't block install. Proceed.
	}

	try {
		await atomicWriteJson(CLAUDE_SETTINGS_PATH, merged);
	} catch (err) {
		return { kind: "error", message: `Could not write settings: ${errorMessage(err)}` };
	}

	return { kind: "installed", previousStatusLine: null };
}

/**
 * Removes our statusLine entry from Claude settings.
 *
 *   - If the current statusLine is exactly ours → remove it, write the rest.
 *   - If it's a different command → return `foreign` and do NOT touch.
 *   - If settings.json is missing or malformed → return without error.
 */
export async function uninstallClaudeSettings(): Promise<ClaudeUninstallResult> {
	const existing = await readSettings();
	if (existing.kind === "malformed") {
		return {
			kind: "malformed-settings",
			hint: `~/.claude/settings.json is not valid JSON. Leaving it untouched. Parse error: ${existing.reason}`,
		};
	}
	if (existing.kind === "absent") {
		return { kind: "not-installed", reason: "~/.claude/settings.json does not exist" };
	}

	const current = existing.data;
	if (!isRecord(current) || current["statusLine"] === undefined) {
		return { kind: "not-installed", reason: "no statusLine entry present" };
	}

	if (!statusLineMatchesOurs(current["statusLine"])) {
		return {
			kind: "foreign",
			existing: current["statusLine"],
			hint: "statusLine points at a different command — refusing to remove it. Remove it manually if you want.",
		};
	}

	const { statusLine: _removed, ...rest } = current;
	void _removed;

	try {
		await backupIfPresent(CLAUDE_SETTINGS_PATH);
		await atomicWriteJson(CLAUDE_SETTINGS_PATH, rest);
	} catch (err) {
		return { kind: "error", message: `Could not write settings: ${errorMessage(err)}` };
	}

	return { kind: "removed" };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type ReadResult =
	| { kind: "absent" }
	| { kind: "present"; data: unknown }
	| { kind: "malformed"; reason: string };

async function readSettings(): Promise<ReadResult> {
	let raw: string;
	try {
		raw = await readFile(CLAUDE_SETTINGS_PATH, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
		return { kind: "malformed", reason: errorMessage(err) };
	}

	if (raw.trim() === "") {
		// Treat empty file as absent — Claude Code would do the same.
		return { kind: "absent" };
	}

	try {
		return { kind: "present", data: JSON.parse(raw) };
	} catch (err) {
		return { kind: "malformed", reason: errorMessage(err) };
	}
}

function statusLineMatchesOurs(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value["type"] !== "command") return false;
	if (typeof value["command"] !== "string") return false;
	// Match on the prefix so we tolerate future flag additions like
	// `token-racer statusline --plain`.
	return value["command"] === STATUSLINE_COMMAND || value["command"].startsWith(`${STATUSLINE_COMMAND} `);
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function backupIfPresent(filePath: string): Promise<void> {
	try {
		await access(filePath);
	} catch {
		return; // Nothing to back up.
	}
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const raw = await readFile(filePath, "utf8");
	await writeFile(`${filePath}.bak-${ts}`, raw, "utf8");
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
	const tmp = `${filePath}.tmp`;
	await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	await rename(tmp, filePath);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// In-source tests
// ---------------------------------------------------------------------------

if (import.meta.vitest != null) {
	describe("statusLineMatchesOurs", () => {
		it("matches the exact command", () => {
			expect(statusLineMatchesOurs({ type: "command", command: STATUSLINE_COMMAND })).toBe(true);
		});

		it("matches command with trailing flags", () => {
			expect(
				statusLineMatchesOurs({ type: "command", command: `${STATUSLINE_COMMAND} --plain` }),
			).toBe(true);
		});

		it("rejects a foreign command", () => {
			expect(statusLineMatchesOurs({ type: "command", command: "cship" })).toBe(false);
		});

		it("rejects wrong type", () => {
			expect(statusLineMatchesOurs({ type: "script", command: STATUSLINE_COMMAND })).toBe(false);
		});

		it("rejects non-object values", () => {
			expect(statusLineMatchesOurs(null)).toBe(false);
			expect(statusLineMatchesOurs("token-racer statusline")).toBe(false);
			expect(statusLineMatchesOurs(undefined)).toBe(false);
		});

		it("rejects command as non-string prefix", () => {
			expect(
				statusLineMatchesOurs({ type: "command", command: `${STATUSLINE_COMMAND}-xtra` }),
			).toBe(false);
		});
	});

	describe("isRecord", () => {
		it("accepts plain objects", () => {
			expect(isRecord({})).toBe(true);
			expect(isRecord({ a: 1 })).toBe(true);
		});
		it("rejects arrays, null, primitives", () => {
			expect(isRecord(null)).toBe(false);
			expect(isRecord([1, 2])).toBe(false);
			expect(isRecord("hello")).toBe(false);
			expect(isRecord(42)).toBe(false);
			expect(isRecord(undefined)).toBe(false);
		});
	});
}
