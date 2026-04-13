import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Provider } from "../providers/provider.ts";

/**
 * Recursively walks `dir` and returns absolute paths of all regular files
 * whose name ends with `extension` (e.g. ".jsonl" or ".json").
 *
 * Returns `[]` silently for:
 *   - missing directories (ENOENT)
 *   - permission errors (EACCES)
 *   - any other I/O failure
 *
 * The goal is "best-effort discovery" — a broken provider directory should
 * never take down a sync pass.
 */
export async function findFilesByExtension(
	dir: string,
	extension: string,
): Promise<string[]> {
	try {
		const entries = await readdir(dir, { recursive: true, withFileTypes: true });
		const results: string[] = [];
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			if (!entry.name.endsWith(extension)) continue;
			// Node 20+ exposes `parentPath`; Node 18 used `path`. Fall back to
			// the root dir if neither is set (defensive only — shouldn't happen).
			const parent =
				(entry as typeof entry & { parentPath?: string }).parentPath ??
				(entry as typeof entry & { path?: string }).path ??
				dir;
			results.push(path.join(parent, entry.name));
		}
		return results;
	} catch {
		return [];
	}
}

/**
 * Lists every log file currently known for a provider, across all of its
 * declared log directories.
 *
 * The provider's `getFilePattern()` is expected to look like `"**\/*.jsonl"`
 * or `"**\/*.json"`; we extract the extension and walk the directory tree.
 * We deliberately do not do glob matching — the provider contract guarantees
 * every file inside the log dir follows the same shape.
 */
export async function discoverFilesForProvider(provider: Provider): Promise<string[]> {
	const extension = path.extname(provider.getFilePattern());
	const dirs = provider.getLogDirs();
	const perDir = await Promise.all(dirs.map((d) => findFilesByExtension(d, extension)));
	// Flatten and dedup (two dirs pointing at the same file would double-count).
	return [...new Set(perDir.flat())];
}

// ---------------------------------------------------------------------------
// In-source tests
// ---------------------------------------------------------------------------

if (import.meta.vitest != null) {
	const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");

	describe("findFilesByExtension", () => {
		let tmpDir: string;

		beforeEach(async () => {
			tmpDir = await mkdtemp(join(tmpdir(), "token-racer-discover-test-"));
		});

		afterEach(async () => {
			await rm(tmpDir, { recursive: true, force: true });
		});

		it("returns files at the top level", async () => {
			await writeFile(join(tmpDir, "a.jsonl"), "", "utf8");
			await writeFile(join(tmpDir, "b.jsonl"), "", "utf8");
			const result = await findFilesByExtension(tmpDir, ".jsonl");
			expect(result).toHaveLength(2);
			expect(result.every((p) => p.endsWith(".jsonl"))).toBe(true);
		});

		it("recurses into subdirectories", async () => {
			await mkdir(join(tmpDir, "proj-a"), { recursive: true });
			await mkdir(join(tmpDir, "proj-b", "nested"), { recursive: true });
			await writeFile(join(tmpDir, "proj-a", "ses-1.jsonl"), "", "utf8");
			await writeFile(join(tmpDir, "proj-b", "nested", "ses-2.jsonl"), "", "utf8");
			const result = await findFilesByExtension(tmpDir, ".jsonl");
			expect(result).toHaveLength(2);
		});

		it("filters by extension", async () => {
			await writeFile(join(tmpDir, "a.jsonl"), "", "utf8");
			await writeFile(join(tmpDir, "b.txt"), "", "utf8");
			await writeFile(join(tmpDir, "c.json"), "", "utf8");
			const result = await findFilesByExtension(tmpDir, ".jsonl");
			expect(result).toHaveLength(1);
			expect(result[0]).toMatch(/a\.jsonl$/);
		});

		it("returns [] for a missing directory", async () => {
			const result = await findFilesByExtension(join(tmpDir, "no-such-dir"), ".jsonl");
			expect(result).toEqual([]);
		});

		it("returns [] for an empty directory", async () => {
			const result = await findFilesByExtension(tmpDir, ".jsonl");
			expect(result).toEqual([]);
		});
	});
}
