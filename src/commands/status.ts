import { readFile } from "node:fs/promises";
import { define } from "gunshi";
import pc from "picocolors";
import { CURSORS_FILE, CONFIG_FILE, LAST_SYNC_FILE } from "../constants.ts";
import { CursorStore } from "../state/cursor-store.ts";
import { loadConfig } from "../setup.ts";

const statusCommand = define({
	name: "status",
	description: "Show the current token-racer configuration and recent sync state.",
	args: {},
	async run(_ctx) {
		try {
			await runStatus();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			process.stderr.write(pc.red(`Error: ${message}\n`));
			process.exitCode = 1;
		}
	},
});

async function runStatus(): Promise<void> {
	const [config, trackedCount, lastSync] = await Promise.all([
		loadConfig(),
		getTrackedFileCount(),
		readLastSync(),
	]);

	const registered = config?.apiKey != null && config.apiKey !== "";
	const apiUrl = config?.apiUrl ?? pc.dim("n/a");
	const username = config?.username ?? pc.dim("n/a");

	process.stdout.write("\n");
	process.stdout.write(`  ${pc.bold("token-racer")} status\n`);
	process.stdout.write(`  ${"─".repeat(36)}\n`);
	process.stdout.write(
		`  Registered:    ${registered ? pc.green("yes") : pc.red("no — run `token-racer auth register`")}\n`,
	);
	process.stdout.write(`  Username:      ${username}\n`);
	process.stdout.write(`  Backend:       ${apiUrl}\n`);
	process.stdout.write(`  Tracked files: ${trackedCount}\n`);

	if (lastSync !== null) {
		const age = formatAge(Date.now() - new Date(lastSync.at).getTime());
		const suffix =
			lastSync.error !== undefined
				? ` ${pc.red(`(error: ${lastSync.error})`)}`
				: ` (sent ${lastSync.accepted} event${lastSync.accepted === 1 ? "" : "s"})`;
		process.stdout.write(`  Last sync:     ${age} ago${suffix}\n`);
	} else {
		process.stdout.write(`  Last sync:     ${pc.dim("never")}\n`);
	}

	process.stdout.write(`  Config:        ${pc.dim(CONFIG_FILE)}\n`);
	process.stdout.write(`  Cursors:       ${pc.dim(CURSORS_FILE)}\n`);
	process.stdout.write("\n");
}

type LastSync = { at: string; accepted: number; error?: string };

async function readLastSync(): Promise<LastSync | null> {
	try {
		const raw = await readFile(LAST_SYNC_FILE, "utf8");
		return JSON.parse(raw) as LastSync;
	} catch {
		return null;
	}
}

async function getTrackedFileCount(): Promise<number> {
	try {
		const store = new CursorStore(CURSORS_FILE);
		const state = await store.load();
		return Object.keys(state.files).length;
	} catch {
		return 0;
	}
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

export default statusCommand;
