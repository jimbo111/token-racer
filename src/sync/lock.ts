import { open, readFile, stat, unlink } from "node:fs/promises";
import os from "node:os";
import process from "node:process";
import { LOCK_FILE, LOCK_STALE_MS } from "../constants.ts";

export type Lock = {
	/** Absolute path of the lock file we're holding. */
	readonly path: string;
};

type LockFileContents = {
	pid: number;
	hostname: string;
	startedAt: string;
};

/**
 * Attempts to acquire an exclusive lock for the sync pipeline.
 *
 * Lock semantics:
 *   - Created with O_CREAT | O_EXCL — atomically fails if the file already exists.
 *   - If an existing lock is older than LOCK_STALE_MS AND its owning PID is dead,
 *     we consider it stale and take it over.
 *   - Non-blocking: returns `null` immediately when another live process holds it.
 *
 * This is advisory: anyone who respects the lock gets mutual exclusion, but
 * badly-behaved external tools could write to shared state anyway. Since only
 * the CLI touches these files, that's fine.
 */
export async function acquireLock(path: string = LOCK_FILE): Promise<Lock | null> {
	const payload: LockFileContents = {
		pid: process.pid,
		hostname: getHostname(),
		startedAt: new Date().toISOString(),
	};

	// Fast path: O_EXCL create.
	if (await tryCreateExclusive(path, payload)) {
		return { path };
	}

	// Lock file exists. Check if it's stale (abandoned by a crashed process).
	if (await isStaleLock(path)) {
		// Best-effort unlink, then retry. If another caller races us to unlink,
		// the O_EXCL create below will still reject our attempt and we fall
		// through to the "held" return.
		try {
			await unlink(path);
		} catch {
			// Someone else unlinked it first — that's fine.
		}

		if (await tryCreateExclusive(path, payload)) {
			return { path };
		}
	}

	return null;
}

export async function releaseLock(lock: Lock): Promise<void> {
	try {
		await unlink(lock.path);
	} catch {
		// Lock file already gone (stale cleanup elsewhere, or manual deletion).
		// Not worth reporting — the lock is released either way.
	}
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function tryCreateExclusive(path: string, payload: LockFileContents): Promise<boolean> {
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	try {
		// "wx" = O_WRONLY | O_CREAT | O_EXCL
		handle = await open(path, "wx");
		await handle.writeFile(JSON.stringify(payload), "utf8");
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EEXIST") return false;
		// Any other fs error (ENOENT on parent dir, EACCES, etc.) bubbles up as "not acquired".
		return false;
	} finally {
		if (handle !== null) {
			await handle.close().catch(() => undefined);
		}
	}
}

async function isStaleLock(path: string): Promise<boolean> {
	let contents: LockFileContents;
	let lastModifiedMs: number;

	try {
		const [raw, fileStat] = await Promise.all([readFile(path, "utf8"), stat(path)]);
		contents = JSON.parse(raw) as LockFileContents;
		lastModifiedMs = fileStat.mtimeMs;
	} catch {
		// Unreadable or malformed lock file — treat as stale so we don't deadlock forever.
		return true;
	}

	const ageMs = Date.now() - lastModifiedMs;
	if (ageMs < LOCK_STALE_MS) return false;

	// Lock is old. Is the PID still alive?
	if (!isSameHost(contents.hostname)) {
		// We can't probe a PID on another host; age alone decides.
		return true;
	}

	return !pidIsAlive(contents.pid);
}

function pidIsAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		// Signal 0 is a probe — doesn't deliver, only checks permission/existence.
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		// EPERM = process exists but we don't own it → still alive.
		// ESRCH = no such process → dead.
		return code === "EPERM";
	}
}

function getHostname(): string {
	try {
		return os.hostname();
	} catch {
		return "";
	}
}

function isSameHost(recordedHostname: string): boolean {
	return recordedHostname === getHostname();
}

// ---------------------------------------------------------------------------
// In-source tests
// ---------------------------------------------------------------------------

if (import.meta.vitest != null) {
	const { mkdtemp, rm, writeFile, utimes } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");

	describe("acquireLock / releaseLock", () => {
		let tmpDir: string;

		beforeEach(async () => {
			tmpDir = await mkdtemp(join(tmpdir(), "token-racer-lock-test-"));
		});

		afterEach(async () => {
			await rm(tmpDir, { recursive: true, force: true });
		});

		async function safeRelease(lock: Lock | null): Promise<void> {
			if (lock !== null) await releaseLock(lock);
		}

		it("acquires a fresh lock", async () => {
			const lockPath = join(tmpDir, "sync.lock");
			const lock = await acquireLock(lockPath);
			expect(lock).not.toBeNull();
			expect(lock?.path).toBe(lockPath);
			await safeRelease(lock);
		});

		it("refuses to acquire when a live lock is held", async () => {
			const lockPath = join(tmpDir, "sync.lock");
			const first = await acquireLock(lockPath);
			expect(first).not.toBeNull();

			const second = await acquireLock(lockPath);
			expect(second).toBeNull();

			await safeRelease(first);
		});

		it("acquires again after release", async () => {
			const lockPath = join(tmpDir, "sync.lock");
			const first = await acquireLock(lockPath);
			await safeRelease(first);
			const second = await acquireLock(lockPath);
			expect(second).not.toBeNull();
			await safeRelease(second);
		});

		it("breaks a stale lock whose owning PID is dead", async () => {
			const lockPath = join(tmpDir, "sync.lock");
			// Write a lock file owned by a PID that's almost certainly not running.
			const deadPid = 999_999;
			await writeFile(
				lockPath,
				JSON.stringify({
					pid: deadPid,
					hostname: getHostname(),
					startedAt: new Date().toISOString(),
				}),
				"utf8",
			);
			// Backdate the mtime so the lock looks older than LOCK_STALE_MS.
			const oldMtime = new Date(Date.now() - LOCK_STALE_MS - 1_000);
			await utimes(lockPath, oldMtime, oldMtime);

			const lock = await acquireLock(lockPath);
			expect(lock).not.toBeNull();
			await safeRelease(lock);
		});

		it("breaks a stale lock whose JSON is corrupt", async () => {
			const lockPath = join(tmpDir, "sync.lock");
			await writeFile(lockPath, "not-valid-json{{", "utf8");
			const oldMtime = new Date(Date.now() - LOCK_STALE_MS - 1_000);
			await utimes(lockPath, oldMtime, oldMtime);

			const lock = await acquireLock(lockPath);
			expect(lock).not.toBeNull();
			await safeRelease(lock);
		});

		it("does NOT break a recent lock, even if the PID is dead", async () => {
			const lockPath = join(tmpDir, "sync.lock");
			await writeFile(
				lockPath,
				JSON.stringify({
					pid: 999_999,
					hostname: getHostname(),
					startedAt: new Date().toISOString(),
				}),
				"utf8",
			);
			// Don't backdate — the lock is "fresh".
			const lock = await acquireLock(lockPath);
			expect(lock).toBeNull();
		});
	});
}
