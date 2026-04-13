import crypto from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { KeyObject } from "node:crypto";
import {
	LAST_SYNC_FILE,
	MAX_BYTES_PER_TAIL,
	MAX_EVENTS_PER_BATCH,
} from "../constants.ts";
import { deriveKeyId } from "../crypto/keygen.ts";
import { loadKeyPair } from "../crypto/key-store.ts";
import { signBatch } from "../crypto/signer.ts";
import { detectProviders } from "../providers/auto-detect.ts";
import type { Provider } from "../providers/provider.ts";
import { loadConfig } from "../setup.ts";
import { CursorStore } from "../state/cursor-store.ts";
import { ensureTokenRacerDirs } from "../state/paths.ts";
import type { BatchPayload, TokenEvent } from "../types.ts";
import { BatchSender, normalizeEvent } from "./sender.ts";
import { tailFile } from "./tailer.ts";
import { acquireLock, releaseLock } from "./lock.ts";
import { discoverFilesForProvider } from "./discover.ts";

export type SyncResult =
	| { ok: true; accepted: number; files: number; providers: number; skipped?: false; reason?: undefined }
	| { ok: true; accepted: 0; skipped: true; reason: "locked" | "not-registered" | "no-providers" }
	| { ok: false; error: string; retryable: boolean; statusCode?: number; accepted: number };

type SyncOptions = {
	/**
	 * Inject a sender for testing. If omitted, a real BatchSender is built from
	 * the loaded config's apiUrl + apiKey.
	 */
	sender?: BatchSender;
	/**
	 * Override the byte cap per tailFile call. Default is MAX_BYTES_PER_TAIL.
	 */
	maxBytesPerFile?: number;
};

/**
 * Runs a single sync pass:
 *
 *   1. Acquire an advisory lock (non-blocking). Skip if another sync is active.
 *   2. Load config + keypair. Skip cleanly if not registered.
 *   3. Detect providers, discover files, tail new bytes per file.
 *   4. Chunk events into batches of ≤ MAX_EVENTS_PER_BATCH.
 *   5. Sign + POST each batch. Advance the file's cursor ONLY after all
 *      of that file's batches succeed — a partial failure leaves the cursor
 *      behind so the next sync retries (backend dedup handles the overlap).
 *   6. Persist last-sync timestamp for `status`.
 *
 * Edge cases handled:
 *   - Missing config / keypair → skip with "not-registered"
 *   - Lock held by another process → skip with "locked"
 *   - No providers installed → skip with "no-providers"
 *   - Provider with zero new events → skip that provider silently
 *   - File rotated or deleted → tailer resets cursor to 0 automatically
 *   - Malformed log lines → tailer skips them but advances past the bytes
 *   - Batch cap exceeded → chunk into multiple POSTs per file
 *   - Huge single file → maxBytes cap stops mid-file; next sync continues
 *   - Network failure / 5xx → error returned, cursor not advanced, retry next sync
 *   - Auth failure (401/403) → error returned, cursor not advanced, user must re-register
 */
export async function sync(options: SyncOptions = {}): Promise<SyncResult> {
	await ensureTokenRacerDirs();

	const lock = await acquireLock();
	if (lock === null) {
		return { ok: true, accepted: 0, skipped: true, reason: "locked" };
	}

	try {
		return await runSync(options);
	} finally {
		await releaseLock(lock);
	}
}

async function runSync(options: SyncOptions): Promise<SyncResult> {
	// ---- Load identity ------------------------------------------------------
	const config = await loadConfig();
	if (config?.apiKey == null || config.apiKey === "") {
		return { ok: true, accepted: 0, skipped: true, reason: "not-registered" };
	}

	const keyPair = await loadKeyPair();
	if (keyPair === null) {
		return { ok: true, accepted: 0, skipped: true, reason: "not-registered" };
	}

	const { publicKey, privateKey } = keyPair;
	const keyId = deriveKeyId(publicKey);

	// ---- Wire sender --------------------------------------------------------
	const sender =
		options.sender ??
		new BatchSender({
			apiUrl: config.apiUrl,
			apiKey: config.apiKey,
		});

	// ---- Detect providers ---------------------------------------------------
	const providers = await detectProviders();
	if (providers.length === 0) {
		await writeLastSync({ at: new Date().toISOString(), accepted: 0 });
		return { ok: true, accepted: 0, skipped: true, reason: "no-providers" };
	}

	// ---- Load cursor store --------------------------------------------------
	const cursors = new CursorStore();
	await cursors.load();

	const maxBytesPerFile = options.maxBytesPerFile ?? MAX_BYTES_PER_TAIL;

	let totalAccepted = 0;
	let totalFiles = 0;
	let firstError: { error: string; retryable: boolean; statusCode?: number } | null = null;

	// ---- Per-provider, per-file sync loop -----------------------------------
	outer: for (const { provider } of providers) {
		const files = await discoverFilesForProvider(provider);

		for (const filePath of files) {
			const fileResult = await syncOneFile({
				filePath,
				provider,
				cursors,
				sender,
				privateKey,
				keyId,
				maxBytesPerFile,
			});

			if (!fileResult.ok) {
				// Abort the whole sync on first error so we don't hammer the
				// backend when auth is dead or the server is down. Cursors for
				// files we already finished stay advanced (flushed per-file below).
				firstError = {
					error: fileResult.error,
					retryable: fileResult.retryable,
					...(fileResult.statusCode !== undefined ? { statusCode: fileResult.statusCode } : {}),
				};
				break outer;
			}

			if (fileResult.accepted > 0) {
				totalFiles += 1;
				totalAccepted += fileResult.accepted;
			}

			// Persist the cursor store after every file that made progress, so
			// a crash mid-sync doesn't cost us the advancement we already earned.
			if (fileResult.cursorChanged) {
				await cursors.flush();
			}
		}
	}

	// Write last-sync stamp regardless of partial success — a failing sync
	// still signals "we were alive at this time", which is useful for `status`.
	await writeLastSync({
		at: new Date().toISOString(),
		accepted: totalAccepted,
		...(firstError !== null ? { error: firstError.error } : {}),
	});

	if (firstError !== null) {
		return {
			ok: false,
			error: firstError.error,
			retryable: firstError.retryable,
			...(firstError.statusCode !== undefined ? { statusCode: firstError.statusCode } : {}),
			accepted: totalAccepted,
		};
	}

	return {
		ok: true,
		accepted: totalAccepted,
		files: totalFiles,
		providers: providers.length,
	};
}

// ---------------------------------------------------------------------------
// Per-file logic
// ---------------------------------------------------------------------------

type SyncFileArgs = {
	filePath: string;
	provider: Provider;
	cursors: CursorStore;
	sender: BatchSender;
	privateKey: KeyObject;
	keyId: string;
	maxBytesPerFile: number;
};

type SyncFileResult =
	| { ok: true; accepted: number; cursorChanged: boolean }
	| { ok: false; error: string; retryable: boolean; statusCode?: number };

async function syncOneFile(args: SyncFileArgs): Promise<SyncFileResult> {
	const { filePath, provider, cursors, sender, privateKey, keyId, maxBytesPerFile } = args;

	const cursor = cursors.getCursor(filePath) ?? { byteOffset: 0, lineCount: 0 };

	let tailResult;
	try {
		tailResult = await tailFile(filePath, cursor.byteOffset, cursor.lineCount, provider, {
			maxBytes: maxBytesPerFile,
		});
	} catch (err) {
		// tailFile already guards against missing/rotated files and most I/O
		// errors; anything that bubbles up is unexpected. Treat as retryable.
		return {
			ok: false,
			error: `tail failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
			retryable: true,
		};
	}

	// No events and no byte advancement → file unchanged, do nothing.
	if (tailResult.events.length === 0 && tailResult.newByteOffset === cursor.byteOffset) {
		return { ok: true, accepted: 0, cursorChanged: false };
	}

	// Byte advancement but no parseable events (e.g. the new bytes were blank
	// lines or malformed JSON). Advance the cursor so we don't re-read them,
	// but there's nothing to ship.
	if (tailResult.events.length === 0) {
		cursors.advanceCursor(filePath, tailResult.newByteOffset, tailResult.newLineCount);
		return { ok: true, accepted: 0, cursorChanged: true };
	}

	// Chunk into ≤ MAX_EVENTS_PER_BATCH batches and POST each.
	const chunks = chunkEvents(tailResult.events, MAX_EVENTS_PER_BATCH);
	let accepted = 0;

	for (const chunk of chunks) {
		const sendResult = await signAndSend(chunk, privateKey, keyId, sender);
		if (!sendResult.ok) {
			// Partial-file failure: do NOT advance the cursor. Next sync re-reads
			// the whole tailed range from this cursor. Backend dedup handles the
			// subset that already succeeded in prior chunks.
			return {
				ok: false,
				error: sendResult.error,
				retryable: sendResult.retryable,
				...(sendResult.statusCode !== undefined ? { statusCode: sendResult.statusCode } : {}),
			};
		}
		accepted += sendResult.accepted;
	}

	// All chunks for this file succeeded — commit the cursor.
	cursors.advanceCursor(filePath, tailResult.newByteOffset, tailResult.newLineCount);
	return { ok: true, accepted, cursorChanged: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function chunkEvents<T>(events: T[], chunkSize: number): T[][] {
	if (chunkSize <= 0) throw new Error("chunkSize must be > 0");
	const chunks: T[][] = [];
	for (let i = 0; i < events.length; i += chunkSize) {
		chunks.push(events.slice(i, i + chunkSize));
	}
	return chunks;
}

type SignSendResult =
	| { ok: true; accepted: number }
	| { ok: false; error: string; retryable: boolean; statusCode?: number };

async function signAndSend(
	events: TokenEvent[],
	privateKey: KeyObject,
	keyId: string,
	sender: BatchSender,
): Promise<SignSendResult> {
	const normalized = events.map(normalizeEvent);
	const batchId = crypto.randomUUID();
	const timestamp = new Date().toISOString();

	let signature: string;
	try {
		signature = signBatch(normalized, batchId, timestamp, privateKey);
	} catch (err) {
		return {
			ok: false,
			error: `sign failed: ${err instanceof Error ? err.message : String(err)}`,
			retryable: false,
		};
	}

	const batch: BatchPayload = {
		version: 1,
		batchId,
		keyId,
		timestamp,
		events: normalized,
		signature,
	};

	const result = await sender.send(batch);
	if (result.ok) {
		return { ok: true, accepted: result.accepted };
	}
	return {
		ok: false,
		error: result.error,
		retryable: result.retryable,
		...(result.statusCode !== undefined ? { statusCode: result.statusCode } : {}),
	};
}

type LastSync = {
	at: string;
	accepted: number;
	error?: string;
};

async function writeLastSync(record: LastSync): Promise<void> {
	try {
		await writeFile(LAST_SYNC_FILE, JSON.stringify(record, null, 2), {
			encoding: "utf8",
			mode: 0o600,
		});
	} catch {
		// Non-critical — swallow.
	}
}

// ---------------------------------------------------------------------------
// In-source tests
// ---------------------------------------------------------------------------

if (import.meta.vitest != null) {
	describe("chunkEvents", () => {
		it("splits into equal chunks when length is a multiple", () => {
			const chunks = chunkEvents([1, 2, 3, 4, 5, 6], 2);
			expect(chunks).toEqual([[1, 2], [3, 4], [5, 6]]);
		});

		it("produces a shorter final chunk when length is not a multiple", () => {
			const chunks = chunkEvents([1, 2, 3, 4, 5], 2);
			expect(chunks).toEqual([[1, 2], [3, 4], [5]]);
		});

		it("returns a single chunk when chunkSize >= length", () => {
			const chunks = chunkEvents([1, 2, 3], 10);
			expect(chunks).toEqual([[1, 2, 3]]);
		});

		it("returns [] for an empty array", () => {
			expect(chunkEvents([], 3)).toEqual([]);
		});

		it("throws for non-positive chunkSize", () => {
			expect(() => chunkEvents([1], 0)).toThrow();
			expect(() => chunkEvents([1], -1)).toThrow();
		});
	});
}
