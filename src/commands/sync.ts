import { define } from "gunshi";
import pc from "picocolors";
import { sync } from "../sync/sync.ts";

const syncCommand = define({
	name: "sync",
	description:
		"Read any new token usage from installed LLM tools, sign batches, and POST them to the backend.",
	args: {
		quiet: {
			type: "boolean",
			short: "q",
			description: "Print only errors (use this for background/detached invocations).",
			default: false,
		},
	},
	async run(ctx) {
		const { quiet } = ctx.values;

		try {
			const result = await sync();

			if (!result.ok) {
				// Failure — always print, even in quiet mode.
				const retryStr = result.retryable ? " (will retry next sync)" : " (non-retryable)";
				process.stderr.write(
					`${pc.red("sync failed:")} ${result.error}${retryStr}\n`,
				);
				process.exit(result.retryable ? 0 : 1);
			}

			if (quiet) return;

			if (result.skipped === true) {
				const messages: Record<typeof result.reason, string> = {
					locked: "another sync is in progress — skipped",
					"not-registered": "not registered yet — run `token-racer auth register` first",
					"no-providers": "no LLM tools detected — nothing to sync",
				};
				process.stdout.write(`${pc.dim(messages[result.reason])}\n`);
				return;
			}

			if (result.accepted === 0) {
				process.stdout.write(`${pc.dim("up to date — no new events")}\n`);
				return;
			}

			process.stdout.write(
				`${pc.green("✓")} Sent ${pc.bold(String(result.accepted))} event(s) from ${result.files} file(s) across ${result.providers} provider(s).\n`,
			);
		} catch (err) {
			// Last-resort guard — `sync()` should already convert exceptions into
			// SyncResult errors, but if something slips through we don't want the
			// CLI to crash silently in detached mode.
			process.stderr.write(
				`${pc.red("sync crashed:")} ${err instanceof Error ? err.message : String(err)}\n`,
			);
			process.exit(1);
		}
	},
});

export default syncCommand;
