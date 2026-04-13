import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { define } from "gunshi";
import pc from "picocolors";
import { generateKeyPair, deriveKeyId } from "../crypto/keygen.ts";
import { saveKeyPair, loadPublicKey, keyPairExists } from "../crypto/key-store.ts";
import { ensureTokenRacerDirs } from "../state/paths.ts";
import { loadConfig, checkpointExistingLogs } from "../setup.ts";
import { detectProviders } from "../providers/auto-detect.ts";
import { KEYS_DIR, CONFIG_FILE, DEFAULT_API_URL } from "../constants.ts";
import { promptWithDefault, isInteractive } from "../io/prompt.ts";
import type { DaemonConfig } from "../types.ts";

const authCommand = define({
	name: "auth",
	description: "Manage authentication keys (init | register | nickname | show)",
	args: {
		force: {
			type: "boolean",
			short: "f",
			description: "Force overwrite existing keys (init only)",
			default: false,
		},
		apiUrl: {
			type: "string",
			description: "API base URL for registration / rename",
			default: DEFAULT_API_URL,
		},
		nickname: {
			type: "string",
			description:
				"Nickname to register with (3–30 chars, letters/digits/dashes). Skip to prompt / auto-generate.",
		},
	},
	async run(ctx) {
		const operation = ctx.positionals[1];

		if (!operation) {
			process.stderr.write(
				pc.red(
					"Error: operation required. Usage: token-racer auth <init|register|nickname|show>\n",
				),
			);
			process.exitCode = 1;
			return;
		}

		try {
			switch (operation) {
				case "init":
					await runInit(ctx.values.force);
					break;
				case "register": {
					const outcome = await runRegister(ctx.values.apiUrl, ctx.values.nickname);
					if (outcome === "failed") process.exitCode = 1;
					break;
				}
				case "nickname": {
					const newName = ctx.positionals[2];
					if (newName === undefined || newName === "") {
						process.stderr.write(
							pc.red("Error: new nickname required. Usage: token-racer auth nickname <new>\n"),
						);
						process.exitCode = 1;
						return;
					}
					await runRename(ctx.values.apiUrl, newName);
					break;
				}
				case "show":
					await runShow();
					break;
				default:
					process.stderr.write(
						pc.red(
							`Error: unknown operation "${operation}". Expected: init, register, nickname, or show\n`,
						),
					);
					process.exitCode = 1;
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			process.stderr.write(pc.red(`Error: ${message}\n`));
			process.exitCode = 1;
		}
	},
});

// ---------------------------------------------------------------------------
// auth init
// ---------------------------------------------------------------------------

async function runInit(force: boolean): Promise<void> {
	await ensureTokenRacerDirs();

	const exists = await keyPairExists();
	if (exists && !force) {
		process.stderr.write(
			pc.red("Error: key pair already exists. Use --force to overwrite.\n"),
		);
		process.stderr.write(pc.dim(`  Keys directory: ${KEYS_DIR}\n`));
		process.exitCode = 1;
		return;
	}

	if (exists && force) {
		process.stdout.write(pc.yellow("Warning: overwriting existing key pair.\n"));
	}

	const { publicKey, privateKey } = generateKeyPair();
	const keyId = deriveKeyId(publicKey);

	await saveKeyPair(publicKey, privateKey);

	process.stdout.write(pc.green("Key pair generated successfully.\n"));
	process.stdout.write(`  Key ID:     ${pc.bold(keyId)}\n`);
	process.stdout.write(`  Public key: ${pc.dim(join(KEYS_DIR, "public.pem"))}\n`);
	process.stdout.write(`  Private key: ${pc.dim(join(KEYS_DIR, "private.pem"))}\n`);
}

// ---------------------------------------------------------------------------
// auth register
// ---------------------------------------------------------------------------

export type RegisterOutcome = "success" | "already-registered" | "failed";

export async function runRegister(
	apiUrl: string,
	cliNickname: string | undefined,
): Promise<RegisterOutcome> {
	const publicKey = await loadPublicKey();
	if (publicKey === null) {
		process.stderr.write(
			pc.red("Error: no key pair found. Run `token-racer auth init` first.\n"),
		);
		return "failed";
	}

	const keyId = deriveKeyId(publicKey);
	const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;

	// Strip the 12-byte Ed25519 SPKI header to obtain raw 32-byte key material.
	const HEADER_BYTES = 12;
	if (der.length < HEADER_BYTES + 32) {
		process.stderr.write(pc.red("Error: unexpected public key DER length.\n"));
		return "failed";
	}
	const publicKeyHex = der.subarray(HEADER_BYTES).toString("hex");

	const url = `${apiUrl.replace(/\/$/, "")}/v1/auth/register`;

	// Registration loop: keeps prompting the interactive user on
	// nickname-taken / bad-format until success. In non-interactive contexts
	// (CI, piped stdin, --nickname provided without TTY) only one attempt is
	// made; failures surface as errors.
	//
	// Nickname policy: the backend reserves `racer-*` names for its own auto-
	// generation pattern, so we NEVER send a suggested value from the CLI.
	// Blank input → omit `displayName` entirely, letting the backend mint a
	// `racer-XXXXXXXX` for us. Typed input is sent verbatim.
	let attempts = 0;
	const MAX_ATTEMPTS = isInteractive() && cliNickname === undefined ? 8 : 1;
	let lastHint: string | null = null;
	let nicknameToTry: string | undefined = cliNickname;
	let promptedThisLoop = cliNickname !== undefined;

	while (attempts < MAX_ATTEMPTS) {
		attempts += 1;

		// Decide which nickname to send — only prompt when we haven't yet
		// captured a value for this attempt.
		if (!promptedThisLoop) {
			// Interactive path. Prints any error from the previous attempt first.
			if (lastHint !== null) {
				process.stdout.write(pc.yellow(`  ${lastHint}\n`));
			}
			const prompt = `  Nickname ${pc.dim("(blank = auto-generate)")}: `;
			const answer = await promptWithDefault(prompt, "");
			// Empty input → send nothing, let backend auto-generate.
			nicknameToTry = answer === "" ? undefined : answer;
			promptedThisLoop = true;
		}

		process.stdout.write(`  Registering with ${pc.dim(url)} ...\n`);

		const result = await tryRegister(url, publicKeyHex, nicknameToTry);

		if (result.kind === "success") {
			await persistConfig(apiUrl, result.body);

			// First-run checkpoint: seed cursors at EOF for every existing log
			// file so the first `sync` doesn't flood the backend with months of
			// historical events.
			const providers = await detectProviders().catch(() => []);
			const checkpointed = await checkpointExistingLogs(
				providers.map((p) => p.provider),
			);

			process.stdout.write(pc.green("Registration successful.\n"));
			process.stdout.write(`  Key ID:   ${pc.bold(keyId)}\n`);
			process.stdout.write(`  Username: ${pc.bold(result.body.username)}\n`);
			process.stdout.write(`  API key saved to ${pc.dim(CONFIG_FILE)}\n`);
			if (checkpointed > 0) {
				process.stdout.write(
					`  ${pc.green("✓")} Checkpointed ${pc.bold(String(checkpointed))} existing log file(s) — only new events will sync\n`,
				);
			}
			return "success";
		}

		if (result.kind === "key-registered") {
			process.stdout.write(pc.yellow("Key already registered with this backend.\n"));
			process.stdout.write(`  Key ID: ${pc.bold(keyId)}\n`);
			process.stdout.write(
				pc.dim(
					"  No local config written. If you wiped ~/.token-racer/, restore\n  keys/ from backup — the backend will not re-issue an API key.\n",
				),
			);
			return "already-registered";
		}

		if (result.kind === "network-error") {
			process.stderr.write(pc.red(`Error: backend unreachable — ${result.message}\n`));
			return "failed";
		}

		if (result.kind === "username-taken") {
			lastHint =
				nicknameToTry === undefined
					? "Auto-generated nickname collided — trying again."
					: `Nickname "${nicknameToTry}" is already taken — try another.`;
			nicknameToTry = undefined;
			promptedThisLoop = false; // force re-prompt in the next iteration
			continue;
		}

		if (result.kind === "bad-format") {
			lastHint = `Invalid nickname: ${result.hint}`;
			nicknameToTry = undefined;
			promptedThisLoop = false;
			continue;
		}

		// Other errors: surface and stop.
		process.stderr.write(
			pc.red(`Error: registration failed (HTTP ${result.status}): ${result.message}\n`),
		);
		return "failed";
	}

	// Exhausted retries.
	process.stderr.write(
		pc.red(
			`Error: could not register after ${MAX_ATTEMPTS} attempt(s). ${lastHint ?? ""}\n`,
		),
	);
	return "failed";
}

// ---------------------------------------------------------------------------
// auth nickname <new>
// ---------------------------------------------------------------------------

async function runRename(apiUrl: string, newName: string): Promise<void> {
	const config = await loadConfig();
	if (config?.apiKey == null || config.apiKey === "") {
		process.stderr.write(
			pc.red(
				"Error: not registered. Run `token-racer auth register` first.\n",
			),
		);
		process.exitCode = 1;
		return;
	}

	const resolvedApiUrl = config.apiUrl ?? apiUrl;
	const url = `${resolvedApiUrl.replace(/\/$/, "")}/v1/users/me`;

	let response: Response;
	try {
		response = await fetch(url, {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${config.apiKey}`,
			},
			body: JSON.stringify({ username: newName }),
			signal: AbortSignal.timeout(10_000),
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		process.stderr.write(pc.red(`Error: backend unreachable — ${message}\n`));
		process.exitCode = 1;
		return;
	}

	if (response.ok) {
		const body = (await response.json()) as { userId: string; username: string };

		const merged: DaemonConfig = {
			...config,
			userId: body.userId,
			username: body.username,
		};
		await writeFile(CONFIG_FILE, JSON.stringify(merged, null, 2), {
			encoding: "utf8",
			mode: 0o600,
		});

		process.stdout.write(pc.green("Nickname updated.\n"));
		process.stdout.write(
			`  ${pc.dim(config.username ?? "(previous)")} → ${pc.bold(body.username)}\n`,
		);
		return;
	}

	if (response.status === 409) {
		process.stderr.write(
			pc.red(`Error: nickname "${newName}" is already taken — pick another.\n`),
		);
		process.exitCode = 1;
		return;
	}

	if (response.status === 400) {
		const body = await response.json().catch(() => ({})) as { issues?: Record<string, string[]> };
		const firstHint =
			body.issues !== undefined
				? Object.values(body.issues).flat().at(0) ?? "invalid nickname"
				: "invalid nickname";
		process.stderr.write(pc.red(`Error: ${firstHint}\n`));
		process.exitCode = 1;
		return;
	}

	if (response.status === 401 || response.status === 403) {
		process.stderr.write(
			pc.red(
				"Error: API key rejected. Your key may have been rotated — re-run `token-racer auth register`.\n",
			),
		);
		process.exitCode = 1;
		return;
	}

	const text = await response.text().catch(() => `HTTP ${response.status}`);
	process.stderr.write(
		pc.red(`Error: rename failed (HTTP ${response.status}): ${text}\n`),
	);
	process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// auth show
// ---------------------------------------------------------------------------

async function runShow(): Promise<void> {
	const publicKey = await loadPublicKey();
	if (publicKey === null) {
		process.stderr.write(
			pc.red("Error: no key pair found. Run `token-racer auth init` first.\n"),
		);
		process.exitCode = 1;
		return;
	}

	const keyId = deriveKeyId(publicKey);
	const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;

	process.stdout.write(`Key ID:     ${pc.bold(keyId)}\n`);
	process.stdout.write(`Public key path: ${pc.dim(join(KEYS_DIR, "public.pem"))}\n\n`);
	process.stdout.write(pc.dim(publicKeyPem));
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

type RegisterResult =
	| { kind: "success"; body: { userId: string; username: string; apiKey: string } }
	| { kind: "key-registered" }
	| { kind: "username-taken" }
	| { kind: "bad-format"; hint: string }
	| { kind: "network-error"; message: string }
	| { kind: "other"; status: number; message: string };

async function tryRegister(
	url: string,
	publicKeyHex: string,
	nickname?: string,
): Promise<RegisterResult> {
	const body: Record<string, unknown> = { publicKeyHex };
	// Omit displayName entirely when blank so the backend auto-generates.
	// Sending a client-chosen `racer-*` name would be rejected as reserved.
	if (nickname !== undefined) {
		body.displayName = nickname;
	}

	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(10_000),
		});
	} catch (err) {
		return {
			kind: "network-error",
			message: err instanceof Error ? err.message : String(err),
		};
	}

	if (response.ok) {
		const body = (await response.json()) as {
			userId: string;
			username: string;
			apiKey: string;
		};
		return { kind: "success", body };
	}

	if (response.status === 400) {
		const body = (await response.json().catch(() => ({}))) as {
			issues?: Record<string, string[]>;
		};
		const firstHint =
			body.issues !== undefined
				? Object.values(body.issues).flat().at(0) ?? "invalid input"
				: "invalid input";
		return { kind: "bad-format", hint: firstHint };
	}

	if (response.status === 409) {
		const body = (await response.json().catch(() => ({}))) as { reason?: string };
		if (body.reason === "username-taken") return { kind: "username-taken" };
		if (body.reason === "key-registered") return { kind: "key-registered" };
		// Older backend that doesn't send a reason — fall back to key-registered.
		return { kind: "key-registered" };
	}

	const message = await response.text().catch(() => `HTTP ${response.status}`);
	return { kind: "other", status: response.status, message };
}

async function persistConfig(
	apiUrl: string,
	body: { userId: string; username: string; apiKey: string },
): Promise<void> {
	const existing = await loadConfig();
	const config: DaemonConfig = {
		apiUrl,
		...(existing ?? {}),
		apiKey: body.apiKey,
		userId: body.userId,
		username: body.username,
	};
	await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), {
		encoding: "utf8",
		mode: 0o600,
	});
}

export default authCommand;
