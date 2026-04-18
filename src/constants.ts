import os from "node:os";
import path from "node:path";

export const TOKEN_RACER_DIR = path.join(os.homedir(), ".token-racer");

export const KEYS_DIR = path.join(TOKEN_RACER_DIR, "keys");
export const CURSORS_FILE = path.join(TOKEN_RACER_DIR, "cursors.json");
export const CONFIG_FILE = path.join(TOKEN_RACER_DIR, "config.json");
export const LOCK_FILE = path.join(TOKEN_RACER_DIR, "sync.lock");
export const LAST_SYNC_FILE = path.join(TOKEN_RACER_DIR, "last-sync.json");

/** Max events per batch (backend-enforced). */
export const MAX_EVENTS_PER_BATCH = 500;

/** Max bytes tailFile reads in a single call — caps memory when catching up from a long offline gap. */
export const MAX_BYTES_PER_TAIL = 10 * 1024 * 1024; // 10 MB

/** How old a lock file must be before it's considered stale and breakable. */
export const LOCK_STALE_MS = 60_000; // 60s — a sync that takes longer than this has almost certainly crashed

export const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;
/**
 * Default backend. Users of the hosted Token Racer service don't need to
 * pass --apiUrl. Self-hosters override with --apiUrl on any command, or
 * export TOKEN_RACER_API_URL to change the process-wide default.
 */
export const DEFAULT_API_URL =
	process.env["TOKEN_RACER_API_URL"] ?? "https://token-racer-backend.onrender.com";

/** HTTP request timeout for backend POSTs. */
export const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Timeout for the initial registration POST. Longer than REQUEST_TIMEOUT_MS
 * because the hosted backend sleeps after idle periods (free-tier hosting can
 * take ~30s to wake up). First-time users shouldn't see a "backend unreachable"
 * error just because the server is cold. Regular sync stays fast via
 * REQUEST_TIMEOUT_MS.
 */
export const REGISTRATION_TIMEOUT_MS = 45_000;
