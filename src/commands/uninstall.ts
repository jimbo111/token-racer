import { rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { define } from "gunshi";
import pc from "picocolors";
import { uninstallClaudeSettings } from "../installer/claude-settings.ts";
import { uninstallShellRc, type SupportedShell } from "../installer/shell-rc.ts";
import { TOKEN_RACER_DIR } from "../constants.ts";
import { isInteractive, promptWithDefault } from "../io/prompt.ts";

// Statusline cache + background-sync timestamp stored by commands/statusline.ts
// in $TMPDIR. We don't touch the per-shell $TMPDIR/token-racer-${UID}-$$ files —
// those die with the shell session.
const STATUSLINE_CACHE = path.join(os.tmpdir(), "token-racer-statusline.json");
const LAST_BG_SYNC_CACHE = path.join(os.tmpdir(), "token-racer-last-bg-sync");

const uninstallCommand = define({
	name: "uninstall",
	description:
		"Remove token-racer integrations from Claude Code settings and your shell rc. Use --purge to also delete ~/.token-racer/ (keys, config, cursors, last-sync state) and tmp caches.",
	args: {
		shell: {
			type: "string",
			description: "Override shell detection. One of: zsh, bash, fish.",
		},
		purge: {
			type: "boolean",
			description:
				"Also delete ~/.token-racer/ and tmp caches. Irreversible — your signing key is destroyed.",
			default: false,
		},
		yes: {
			type: "boolean",
			short: "y",
			description:
				"Skip the --purge confirmation prompt. Required when running non-interactively with --purge.",
			default: false,
		},
	},
	async run(ctx) {
		const { shell, purge, yes } = ctx.values;

		process.stdout.write(pc.bold("Removing token-racer integrations...\n"));

		// --- Claude Code settings --------------------------------------------
		const claudeResult = await uninstallClaudeSettings();
		switch (claudeResult.kind) {
			case "removed":
				process.stdout.write(`  ${pc.green("✓")} Claude Code: removed statusLine entry\n`);
				break;
			case "not-installed":
				process.stdout.write(
					`  ${pc.dim(`• Claude Code: nothing to remove (${claudeResult.reason})`)}\n`,
				);
				break;
			case "foreign":
				process.stdout.write(`  ${pc.yellow("⚠")} Claude Code: ${claudeResult.hint}\n`);
				break;
			case "malformed-settings":
				process.stdout.write(`  ${pc.red("✗")} Claude Code: ${claudeResult.hint}\n`);
				break;
			case "error":
				process.stdout.write(`  ${pc.red("✗")} Claude Code: ${claudeResult.message}\n`);
				break;
		}

		// --- Shell rc --------------------------------------------------------
		const shellOverride = normalizeShell(typeof shell === "string" ? shell : undefined);
		const shellResult = await uninstallShellRc(shellOverride);
		switch (shellResult.kind) {
			case "removed":
				process.stdout.write(
					`  ${pc.green("✓")} Shell (${shellResult.shell}): removed Token Racer block from ${shellResult.rcPath}\n`,
				);
				break;
			case "not-installed":
				process.stdout.write(
					`  ${pc.dim(`• Shell: nothing to remove (${shellResult.reason})`)}\n`,
				);
				break;
			case "unsupported-shell":
				process.stdout.write(`  ${pc.yellow("⚠")} Shell: ${shellResult.hint}\n`);
				break;
			case "error":
				process.stdout.write(`  ${pc.red("✗")} Shell: ${shellResult.message}\n`);
				break;
		}

		// --- --purge: wipe local state ---------------------------------------
		if (purge === true) {
			await runPurge(yes === true);
		}

		process.stdout.write(pc.bold("Done.\n"));
	},
});

/**
 * Deletes ~/.token-racer/ (keys, config, cursors, last-sync, lock) plus the
 * two tmp caches maintained by statusline.
 *
 * Leaves per-shell ephemeral caches ($TMPDIR/token-racer-${UID}-$PID) alone —
 * those belong to live shells and die naturally.
 */
async function runPurge(yes: boolean): Promise<void> {
	const plan = await computePurgePlan();

	if (plan.length === 0) {
		process.stdout.write(
			`  ${pc.dim("• Purge: nothing to remove (~/.token-racer and tmp caches already clean)")}\n`,
		);
		return;
	}

	process.stdout.write(pc.yellow("\n⚠ --purge will permanently delete:\n"));
	for (const p of plan) {
		process.stdout.write(pc.yellow(`    ${p}\n`));
	}
	process.stdout.write(
		pc.yellow(
			"  This destroys your Ed25519 signing key. If you're registered, back up\n  ~/.token-racer/keys/ first — without it, you cannot recover your account.\n\n",
		),
	);

	const confirmed = yes ? true : await confirmPurge();
	if (!confirmed) {
		process.stdout.write(
			pc.dim("  Purge aborted. Integrations removed, local state left intact.\n"),
		);
		return;
	}

	const failures = await executePurge(plan);
	if (failures.length > 0) {
		for (const { path: p, message } of failures) {
			process.stdout.write(`  ${pc.red("✗")} Purge: could not remove ${p} (${message})\n`);
		}
		process.exitCode = 1;
		return;
	}

	process.stdout.write(
		`  ${pc.green("✓")} Purge: removed ${plan.length} path${plan.length === 1 ? "" : "s"}\n`,
	);
}

async function computePurgePlan(): Promise<string[]> {
	const candidates = [TOKEN_RACER_DIR, STATUSLINE_CACHE, LAST_BG_SYNC_CACHE];
	const present: string[] = [];
	for (const p of candidates) {
		try {
			await stat(p);
			present.push(p);
		} catch {
			// Absent — nothing to do. ENOENT is the common case; other errors
			// (EACCES on lstat) surface at rm time with a clearer message.
		}
	}
	return present;
}

type PurgeFailure = { path: string; message: string };

async function executePurge(paths: string[]): Promise<PurgeFailure[]> {
	const results = await Promise.all(
		paths.map(async (p): Promise<PurgeFailure | null> => {
			try {
				await rm(p, { recursive: true, force: true });
				return null;
			} catch (err) {
				return { path: p, message: err instanceof Error ? err.message : String(err) };
			}
		}),
	);
	return results.filter((r): r is PurgeFailure => r !== null);
}

async function confirmPurge(): Promise<boolean> {
	if (!isInteractive()) {
		process.stderr.write(
			pc.red(
				"  Refusing to --purge non-interactively without --yes. Re-run with --yes to confirm.\n",
			),
		);
		process.exitCode = 1;
		return false;
	}
	// Fallback is "" so a blank Enter does NOT count as confirmation.
	// User must deliberately type 'purge' to proceed.
	const answer = await promptWithDefault(
		"  Type 'purge' to confirm (anything else aborts): ",
		"",
	);
	return answer.toLowerCase() === "purge";
}

function normalizeShell(v: string | undefined): SupportedShell | undefined {
	if (v === undefined) return undefined;
	const lower = v.toLowerCase();
	if (lower === "zsh" || lower === "bash" || lower === "fish") return lower;
	throw new Error(`Unsupported --shell value: ${v}. Expected one of: zsh, bash, fish.`);
}

export default uninstallCommand;
