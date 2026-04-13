import { readFile, stat, writeFile } from "node:fs/promises";
import pc from "picocolors";
import { generateKeyPair, deriveKeyId } from "./crypto/keygen.ts";
import { saveKeyPair, loadKeyPair, keyPairExists } from "./crypto/key-store.ts";
import { ensureTokenRacerDirs } from "./state/paths.ts";
import { detectProviders } from "./providers/auto-detect.ts";
import { CONFIG_FILE } from "./constants.ts";
import type { DaemonConfig } from "./types.ts";
import { CursorStore } from "./state/cursor-store.ts";
import { discoverFilesForProvider } from "./sync/discover.ts";
import type { Provider } from "./providers/provider.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SetupResult = {
	apiKey: string;
	apiUrl: string;
	keyId: string;
	isFirstRun: boolean;
};

type RegisterResponse = {
	userId: string;
	username: string;
	apiKey: string;
};

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

/**
 * Reads config.json from ~/.token-racer/config.json.
 * Returns null if the file does not exist or cannot be parsed.
 */
export async function loadConfig(): Promise<DaemonConfig | null> {
	try {
		const raw = await readFile(CONFIG_FILE, "utf8");
		return JSON.parse(raw) as DaemonConfig;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the raw 32-byte Ed25519 public key from a DER-encoded SPKI buffer.
 * SPKI for Ed25519 is a 44-byte structure: 12 bytes of algorithm header followed
 * by 32 bytes of key material. We strip the 12-byte header and hex-encode the rest.
 */
function publicKeyToHex(der: Buffer): string {
	// Ed25519 SPKI DER header is always 12 bytes.
	const HEADER_BYTES = 12;
	if (der.length < HEADER_BYTES + 32) {
		throw new Error(`Unexpected SPKI DER length: ${der.length}`);
	}
	return der.subarray(HEADER_BYTES).toString("hex");
}

async function tryRegister(
	apiUrl: string,
	publicKeyHex: string,
): Promise<RegisterResponse | null> {
	const url = `${apiUrl.replace(/\/$/, "")}/v1/auth/register`;
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ publicKeyHex }),
			signal: AbortSignal.timeout(10_000),
		});

		if (response.ok) {
			return (await response.json()) as RegisterResponse;
		}

		if (response.status === 409) {
			// Already registered — backend knows this key.
			return null;
		}

		const text = await response.text().catch(() => `HTTP ${response.status}`);
		throw new Error(`Registration failed (HTTP ${response.status}): ${text}`);
	} catch (err) {
		if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
			throw new Error("Registration timed out — backend may be unreachable.");
		}
		throw err;
	}
}

// ---------------------------------------------------------------------------
// ensureSetup
// ---------------------------------------------------------------------------

/**
 * Ensures the CLI is fully set up — keypair, registration, config.
 *
 * On first run (no apiKey in config.json):
 *   1. Generates an Ed25519 keypair if one does not exist.
 *   2. POSTs the public key to {apiUrl}/v1/auth/register.
 *   3. Writes config.json with the returned apiKey, userId, and username.
 *   4. Prints a welcome message.
 *
 * On subsequent runs (apiKey already in config.json):
 *   Loads and returns the existing config without any network calls.
 *
 * If the backend is unreachable on first run:
 *   Generates the keypair anyway and warns the user. The daemon will queue
 *   events offline and retry once connectivity is restored.
 *
 * The operation is idempotent — safe to call multiple times.
 */
export async function ensureSetup(apiUrl: string): Promise<SetupResult> {
	await ensureTokenRacerDirs();

	// --- Not first run: config already contains an apiKey ---
	const existingConfig = await loadConfig();
	if (existingConfig?.apiKey) {
		const keyPair = await loadKeyPair();
		const keyId =
			keyPair !== null ? deriveKeyId(keyPair.publicKey) : existingConfig.userId ?? "unknown";
		return {
			apiKey: existingConfig.apiKey,
			apiUrl: existingConfig.apiUrl ?? apiUrl,
			keyId,
			isFirstRun: false,
		};
	}

	// --- First run ---
	process.stdout.write(pc.bold("Welcome to Token Racer! Setting up...\n"));

	// Step 1: Ensure keypair exists.
	let keyId: string;
	if (!(await keyPairExists())) {
		const { publicKey, privateKey } = generateKeyPair();
		await saveKeyPair(publicKey, privateKey);
		keyId = deriveKeyId(publicKey);
		process.stdout.write(`  ${pc.green("✓")} Generated Ed25519 keypair\n`);
	} else {
		const kp = await loadKeyPair();
		if (kp === null) throw new Error("Keypair files exist but could not be loaded.");
		keyId = deriveKeyId(kp.publicKey);
		process.stdout.write(`  ${pc.green("✓")} Ed25519 keypair already exists\n`);
	}

	// Step 2: Load the public key and extract raw hex for registration.
	const kp = await loadKeyPair();
	if (kp === null) throw new Error("Setup error: keypair not found after generation.");
	const der = kp.publicKey.export({ type: "spki", format: "der" }) as Buffer;
	const publicKeyHex = publicKeyToHex(der);

	// Step 3: Register with the backend.
	let registrationResult: RegisterResponse | null = null;
	let registrationWarning: string | null = null;

	try {
		registrationResult = await tryRegister(apiUrl, publicKeyHex);
	} catch (err) {
		registrationWarning = err instanceof Error ? err.message : String(err);
	}

	let resolvedApiKey: string;
	let userId: string | undefined;
	let username: string | undefined;

	if (registrationResult !== null) {
		resolvedApiKey = registrationResult.apiKey;
		userId = registrationResult.userId;
		username = registrationResult.username;
		process.stdout.write(
			`  ${pc.green("✓")} Registered with backend (username: ${pc.bold(username)})\n`,
		);
	} else if (registrationWarning !== null) {
		// Backend unreachable: generate a temporary placeholder key so the daemon
		// can start in offline mode. The user can re-register later.
		resolvedApiKey = "";
		process.stdout.write(
			`  ${pc.yellow("⚠")} Backend unreachable — running in offline mode\n`,
		);
		process.stdout.write(
			`    ${pc.dim(`(${registrationWarning})`)}\n`,
		);
		process.stdout.write(
			`    ${pc.dim("Run `token-racer auth register` once the backend is available.")}\n`,
		);
	} else {
		// 409 Conflict: this key was already registered. Try to load an existing
		// config for the apiKey, or fall through to offline mode.
		const cfg = await loadConfig();
		if (cfg?.apiKey) {
			resolvedApiKey = cfg.apiKey;
			userId = cfg.userId;
			username = cfg.username;
			process.stdout.write(
				`  ${pc.green("✓")} Already registered (username: ${pc.bold(username ?? keyId)})\n`,
			);
		} else {
			resolvedApiKey = "";
			process.stdout.write(
				`  ${pc.yellow("⚠")} Already registered but no local config found — running offline\n`,
			);
			process.stdout.write(
				`    ${pc.dim("Run `token-racer auth register` to restore your API key.")}\n`,
			);
		}
	}

	// Step 4: Persist config.json.
	const config: DaemonConfig = {
		apiUrl,
		...(resolvedApiKey ? { apiKey: resolvedApiKey } : {}),
		...(userId !== undefined ? { userId } : {}),
		...(username !== undefined ? { username } : {}),
	};
	await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });

	if (resolvedApiKey) {
		process.stdout.write(`  ${pc.green("✓")} API key saved to ${pc.dim(CONFIG_FILE)}\n`);
	}

	// Step 5: Detect providers and print them.
	const providers = await detectProviders();
	if (providers.length > 0) {
		const names = providers.map((p) => p.provider.displayName).join(", ");
		process.stdout.write(`  ${pc.green("✓")} Detected providers: ${pc.bold(names)}\n`);
	} else {
		process.stdout.write(
			`  ${pc.yellow("⚠")} No LLM tool providers detected on this system\n`,
		);
	}

	// Step 6: Checkpoint existing log files to their current size.
	// Without this, the first sync would upload every historical event sitting
	// on disk — months of stale data would be rejected by anomaly detection
	// (>7 days old) and pointlessly hammer the backend. By seeding cursors at
	// the end of each file, we establish "only new events count from now on".
	const checkpointed = await checkpointExistingLogs(providers.map((p) => p.provider));
	if (checkpointed > 0) {
		process.stdout.write(
			`  ${pc.green("✓")} Checkpointed ${pc.bold(String(checkpointed))} existing log file(s) — only new events will sync\n`,
		);
	}

	return {
		apiKey: resolvedApiKey,
		apiUrl,
		keyId,
		isFirstRun: true,
	};
}

// ---------------------------------------------------------------------------
// Checkpoint: seed cursors at the current end-of-file for every existing log
// ---------------------------------------------------------------------------

export async function checkpointExistingLogs(providers: Provider[]): Promise<number> {
	const cursors = new CursorStore();
	await cursors.load();

	let count = 0;

	for (const provider of providers) {
		let files: string[];
		try {
			files = await discoverFilesForProvider(provider);
		} catch {
			continue;
		}

		for (const filePath of files) {
			// Skip files we've already tracked (shouldn't happen on first run,
			// but this keeps the function idempotent if called a second time).
			if (cursors.getCursor(filePath) !== null) continue;

			let size: number;
			try {
				size = (await stat(filePath)).size;
			} catch {
				continue;
			}

			// Approximate line count by counting newlines. Tailer only needs
			// the byte offset to be correct; line count is informational.
			let lineCount = 0;
			try {
				const raw = await readFile(filePath, "utf8");
				for (let i = 0; i < raw.length; i++) {
					if (raw.charCodeAt(i) === 0x0a) lineCount += 1;
				}
			} catch {
				lineCount = 0;
			}

			cursors.advanceCursor(filePath, size, lineCount);
			count += 1;
		}
	}

	if (count > 0) {
		try {
			await cursors.flush();
		} catch {
			// If we can't persist, we'd rather lose the checkpoint than fail
			// registration — the user can re-register or manually clean up.
			return 0;
		}
	}

	return count;
}
