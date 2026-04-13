import { define } from "gunshi";
import pc from "picocolors";
import { installClaudeSettings } from "../installer/claude-settings.ts";
import { installShellRc, type SupportedShell } from "../installer/shell-rc.ts";

const installCommand = define({
	name: "install",
	description:
		"Wire token-racer into Claude Code (~/.claude/settings.json) and your shell prompt. Idempotent.",
	args: {
		shell: {
			type: "string",
			description: "Override shell detection. One of: zsh, bash, fish.",
		},
		force: {
			type: "boolean",
			description:
				"Overwrite an existing Claude statusLine entry that points at a different command.",
			default: false,
		},
		"skip-claude": {
			type: "boolean",
			description: "Don't touch ~/.claude/settings.json (only install the shell integration).",
			default: false,
		},
		"skip-shell": {
			type: "boolean",
			description: "Don't touch your shell rc file (only install the Claude Code integration).",
			default: false,
		},
	},
	async run(ctx) {
		const { shell, force } = ctx.values;
		const skipClaude = ctx.values["skip-claude"];
		const skipShell = ctx.values["skip-shell"];

		process.stdout.write(pc.bold("Installing token-racer integrations...\n"));

		// --- Claude Code settings --------------------------------------------
		if (skipClaude === true) {
			process.stdout.write(`  ${pc.dim("• Claude Code: skipped (--skip-claude)")}\n`);
		} else {
			const r = await installClaudeSettings({ force });
			switch (r.kind) {
				case "installed":
					process.stdout.write(
						`  ${pc.green("✓")} Claude Code: registered statusLine in ~/.claude/settings.json\n`,
					);
					break;
				case "already-installed":
					process.stdout.write(
						`  ${pc.dim("• Claude Code: already installed")}\n`,
					);
					break;
				case "conflict":
					process.stdout.write(
						`  ${pc.yellow("⚠")} Claude Code: ${r.hint}\n    ${pc.dim(`existing: ${JSON.stringify(r.existing)}`)}\n`,
					);
					break;
				case "malformed-settings":
					process.stdout.write(
						`  ${pc.red("✗")} Claude Code: ${r.hint}\n`,
					);
					break;
				case "error":
					process.stdout.write(`  ${pc.red("✗")} Claude Code: ${r.message}\n`);
					break;
			}
		}

		// --- Shell rc --------------------------------------------------------
		if (skipShell === true) {
			process.stdout.write(`  ${pc.dim("• Shell: skipped (--skip-shell)")}\n`);
		} else {
			const shellOverride = normalizeShell(typeof shell === "string" ? shell : undefined);
			const r = await installShellRc(shellOverride);
			switch (r.kind) {
				case "installed":
					process.stdout.write(
						`  ${pc.green("✓")} Shell (${r.shell}): added Token Racer block to ${r.rcPath}\n`,
					);
					process.stdout.write(
						`    ${pc.dim("Restart your shell or `source` the file to activate.")}\n`,
					);
					break;
				case "already-installed":
					process.stdout.write(
						`  ${pc.dim(`• Shell (${r.shell}): already installed in ${r.rcPath}`)}\n`,
					);
					break;
				case "unsupported-shell":
					process.stdout.write(`  ${pc.yellow("⚠")} Shell: ${r.hint}\n`);
					break;
				case "error":
					process.stdout.write(`  ${pc.red("✗")} Shell: ${r.message}\n`);
					break;
			}
		}

		process.stdout.write(pc.bold("Done.\n"));
	},
});

function normalizeShell(v: string | undefined): SupportedShell | undefined {
	if (v === undefined) return undefined;
	const lower = v.toLowerCase();
	if (lower === "zsh" || lower === "bash" || lower === "fish") return lower;
	throw new Error(`Unsupported --shell value: ${v}. Expected one of: zsh, bash, fish.`);
}

export default installCommand;
