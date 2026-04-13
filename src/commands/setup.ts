import { join } from "node:path";
import { define } from "gunshi";
import pc from "picocolors";
import { runRegister } from "./auth.ts";
import { generateKeyPair, deriveKeyId } from "../crypto/keygen.ts";
import { saveKeyPair, keyPairExists } from "../crypto/key-store.ts";
import { ensureTokenRacerDirs } from "../state/paths.ts";
import { installClaudeSettings } from "../installer/claude-settings.ts";
import { installShellRc, type SupportedShell } from "../installer/shell-rc.ts";
import { loadConfig } from "../setup.ts";
import { sync } from "../sync/sync.ts";
import { DEFAULT_API_URL, KEYS_DIR } from "../constants.ts";

/**
 * One-stop onboarding: generate keys if missing, register with the backend,
 * wire up Claude Code + shell integration, then verify the pipe end-to-end
 * with a live sync. Every step is idempotent — re-running after a partial
 * setup resumes rather than erroring out.
 *
 * What `setup` does NOT do:
 *  - Does NOT rotate keys if a keypair already exists (use `auth init --force`).
 *  - Does NOT re-register if already registered (use `auth nickname` to rename).
 *  - Does NOT modify a `statusLine` that's already pointing at another command
 *    — surfaces the conflict and tells the user how to force it.
 */
const setupCommand = define({
	name: "setup",
	description:
		"One-command onboarding: generate keys, register, wire up Claude Code + shell integration, and verify with a live sync. Idempotent.",
	args: {
		apiUrl: {
			type: "string",
			description: "Backend URL to register with.",
			default: DEFAULT_API_URL,
		},
		nickname: {
			type: "string",
			description:
				"Nickname to register with (3–30 chars). Omit to prompt interactively.",
		},
		shell: {
			type: "string",
			description: "Override shell detection. One of: zsh, bash, fish.",
		},
		force: {
			type: "boolean",
			description:
				"Overwrite an existing Claude statusLine pointing at a different command.",
			default: false,
		},
		"skip-claude": {
			type: "boolean",
			description: "Don't touch ~/.claude/settings.json.",
			default: false,
		},
		"skip-shell": {
			type: "boolean",
			description: "Don't touch your shell rc file.",
			default: false,
		},
	},
	async run(ctx) {
		const { apiUrl, nickname, shell, force } = ctx.values;
		const skipClaude = ctx.values["skip-claude"] === true;
		const skipShell = ctx.values["skip-shell"] === true;

		process.stdout.write(pc.bold("\nSetting up token-racer\n"));
		process.stdout.write(pc.dim(`${"─".repeat(40)}\n\n`));

		// Track warning-level outcomes across all steps so the final summary
		// reflects what actually happened, not just that we reached the end.
		let warnings = 0;

		// --- Step 1: Keypair -------------------------------------------------
		await ensureTokenRacerDirs();
		const hasKeys = await keyPairExists();
		if (hasKeys) {
			process.stdout.write(`  ${pc.green("✓")} Keypair: reusing existing keys at ${pc.dim(KEYS_DIR)}\n`);
		} else {
			const { publicKey, privateKey } = generateKeyPair();
			const keyId = deriveKeyId(publicKey);
			await saveKeyPair(publicKey, privateKey);
			process.stdout.write(`  ${pc.green("✓")} Keypair: generated (keyId ${pc.bold(keyId)})\n`);
			process.stdout.write(`    ${pc.dim(join(KEYS_DIR, "private.pem"))} ${pc.dim("(mode 0600)")}\n`);
		}

		// --- Step 2: Registration --------------------------------------------
		const existingConfig = await loadConfig();
		const alreadyRegistered =
			existingConfig !== null &&
			typeof existingConfig.apiKey === "string" &&
			existingConfig.apiKey !== "" &&
			typeof existingConfig.userId === "string" &&
			existingConfig.userId !== "";

		if (alreadyRegistered) {
			process.stdout.write(
				`  ${pc.green("✓")} Registration: already registered as ${pc.bold(existingConfig.username ?? "(unnamed)")} at ${pc.dim(existingConfig.apiUrl)}\n`,
			);
		} else {
			printPrivacyDisclosure();
			const outcome = await runRegister(
				apiUrl,
				typeof nickname === "string" ? nickname : undefined,
			);
			if (outcome === "failed") {
				process.stdout.write(
					`\n  ${pc.red("✗")} Setup aborted — registration failed. Fix the error above and re-run \`token-racer setup\`.\n`,
				);
				process.exitCode = 1;
				return;
			}
			if (outcome === "already-registered") {
				process.stdout.write(
					`\n  ${pc.yellow("⚠")} Setup aborted — your key is already registered but no local config exists. Restore ~/.token-racer/keys/ from backup.\n`,
				);
				process.exitCode = 1;
				return;
			}
		}

		// --- Step 3: Claude Code settings ------------------------------------
		if (skipClaude) {
			process.stdout.write(`  ${pc.dim("• Claude Code: skipped (--skip-claude)")}\n`);
		} else {
			const r = await installClaudeSettings({ force });
			switch (r.kind) {
				case "installed":
					process.stdout.write(`  ${pc.green("✓")} Claude Code: registered statusLine in ~/.claude/settings.json\n`);
					break;
				case "already-installed":
					process.stdout.write(`  ${pc.green("✓")} Claude Code: already installed\n`);
					break;
				case "conflict":
					process.stdout.write(
						`  ${pc.yellow("⚠")} Claude Code: ${r.hint}\n    ${pc.dim(`existing: ${JSON.stringify(r.existing)}`)}\n`,
					);
					warnings += 1;
					break;
				case "malformed-settings":
					process.stdout.write(`  ${pc.red("✗")} Claude Code: ${r.hint}\n`);
					warnings += 1;
					break;
				case "error":
					process.stdout.write(`  ${pc.red("✗")} Claude Code: ${r.message}\n`);
					warnings += 1;
					break;
			}
		}

		// --- Step 4: Shell rc ------------------------------------------------
		if (skipShell) {
			process.stdout.write(`  ${pc.dim("• Shell: skipped (--skip-shell)")}\n`);
		} else {
			const shellOverride = normalizeShell(typeof shell === "string" ? shell : undefined);
			const r = await installShellRc(shellOverride);
			switch (r.kind) {
				case "installed":
					process.stdout.write(
						`  ${pc.green("✓")} Shell (${r.shell}): added Token Racer block to ${r.rcPath}\n`,
					);
					break;
				case "already-installed":
					process.stdout.write(`  ${pc.green("✓")} Shell (${r.shell}): already installed in ${r.rcPath}\n`);
					break;
				case "unsupported-shell":
					process.stdout.write(`  ${pc.yellow("⚠")} Shell: ${r.hint}\n`);
					warnings += 1;
					break;
				case "error":
					process.stdout.write(`  ${pc.red("✗")} Shell: ${r.message}\n`);
					warnings += 1;
					break;
			}
		}

		// --- Step 5: Verify end-to-end with a live sync ----------------------
		process.stdout.write(`\n  ${pc.dim("Running a verification sync...")}\n`);
		try {
			const result = await sync();
			if (result.ok === false) {
				process.stdout.write(
					`  ${pc.yellow("⚠")} Verify: sync failed — ${result.error}${result.retryable ? pc.dim(" (will retry on next tick)") : ""}\n`,
				);
				warnings += 1;
			} else if (result.skipped === true) {
				// "no-providers" is informational — user may not have used any LLM tool
				// yet. The other skip reasons signal real problems worth flagging.
				if (result.reason === "no-providers") {
					process.stdout.write(
						`  ${pc.dim("•")} Verify: no LLM tools detected yet — events will ship once you prompt Claude Code / Codex / OpenCode\n`,
					);
				} else {
					const reasonMap: Record<Exclude<typeof result.reason, "no-providers">, string> = {
						locked: "another sync is in progress — try again in a moment",
						"not-registered": "not registered (unexpected — please file a bug)",
					};
					process.stdout.write(
						`  ${pc.yellow("⚠")} Verify: ${reasonMap[result.reason]}\n`,
					);
					warnings += 1;
				}
			} else if (result.accepted === 0) {
				process.stdout.write(
					`  ${pc.green("✓")} Verify: pipe is open (no new events to ship yet)\n`,
				);
			} else {
				process.stdout.write(
					`  ${pc.green("✓")} Verify: shipped ${pc.bold(String(result.accepted))} event(s) from ${result.files} file(s) across ${result.providers} provider(s)\n`,
				);
			}
		} catch (err) {
			process.stdout.write(
				`  ${pc.yellow("⚠")} Verify: sync crashed — ${err instanceof Error ? err.message : String(err)}\n`,
			);
			warnings += 1;
		}

		// --- Summary ---------------------------------------------------------
		process.stdout.write(pc.dim(`\n${"─".repeat(40)}\n`));
		if (warnings === 0) {
			process.stdout.write(pc.bold("Setup complete.\n\n"));
		} else {
			process.stdout.write(
				pc.yellow(
					pc.bold(
						`Setup complete with ${warnings} warning${warnings === 1 ? "" : "s"} — see above.\n`,
					),
				),
			);
			process.stdout.write(
				pc.dim("  Run `token-racer doctor` to re-check each component.\n\n"),
			);
			// Non-zero exit so CI / scripting can detect degraded setup.
			process.exitCode = 1;
		}
		process.stdout.write(`  Next steps:\n`);
		if (!skipShell) {
			process.stdout.write(
				`    ${pc.dim("•")} Open a new shell or \`source\` your rc to activate the prompt line\n`,
			);
		}
		process.stdout.write(`    ${pc.dim("•")} Run \`token-racer doctor\` anytime to recheck health\n`);
		process.stdout.write(`    ${pc.dim("•")} Run \`token-racer status\` to see registration + sync state\n\n`);
	},
});

/**
 * Inline privacy disclosure. Shown before registration so the user knows
 * exactly what the first HTTP POST will ship and what stays local.
 *
 * Static text on purpose — URL-fetched disclosure was considered but rejected
 * (would block setup on a flaky network to show a legal notice).
 */
function printPrivacyDisclosure(): void {
	process.stdout.write(pc.bold("  What gets shipped\n"));
	process.stdout.write(
		pc.dim(
			"    Shipped:   token counts, model IDs, timestamps, cost, hashed project\n" +
				"               names (SHA-256, first 12 hex chars), your public key, nickname\n" +
				"    Never:     prompt content, tool calls, file contents, raw paths\n" +
				"    Local:     private key at ~/.token-racer/keys/ (mode 0600, never sent)\n\n",
		),
	);
}

function normalizeShell(v: string | undefined): SupportedShell | undefined {
	if (v === undefined) return undefined;
	const lower = v.toLowerCase();
	if (lower === "zsh" || lower === "bash" || lower === "fish") return lower;
	throw new Error(`Unsupported --shell value: ${v}. Expected one of: zsh, bash, fish.`);
}

export default setupCommand;
