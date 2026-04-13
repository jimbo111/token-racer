import { readFile, writeFile, rename, mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CursorState } from "../types.ts";
import { CURSORS_FILE } from "../constants.ts";

const defaultState = (): CursorState => ({ version: 1, files: {} });

export class CursorStore {
	readonly #filePath: string;
	#state: CursorState;

	constructor(filePath: string = CURSORS_FILE) {
		this.#filePath = filePath;
		this.#state = defaultState();
	}

	async load(): Promise<CursorState> {
		try {
			const raw = await readFile(this.#filePath, "utf8");
			this.#state = JSON.parse(raw) as CursorState;
			return this.#state;
		} catch (err) {
			const error = err as NodeJS.ErrnoException;
			if (error.code === "ENOENT" || err instanceof SyntaxError) {
				this.#state = defaultState();
				return this.#state;
			}
			throw err;
		}
	}

	getCursor(filePath: string): { byteOffset: number; lineCount: number } | null {
		const entry = this.#state.files[filePath];
		if (entry == null) return null;
		return { byteOffset: entry.byteOffset, lineCount: entry.lineCount };
	}

	advanceCursor(filePath: string, byteOffset: number, lineCount: number): void {
		this.#state.files[filePath] = {
			byteOffset,
			lineCount,
			lastModified: new Date().toISOString(),
		};
	}

	async flush(): Promise<void> {
		const tmp = this.#filePath + ".tmp";
		const json = JSON.stringify(this.#state, null, 2);
		await writeFile(tmp, json, { encoding: "utf8" });
		await rename(tmp, this.#filePath);
	}

	prune(maxAgeDays: number): void {
		const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
		this.#state.files = Object.fromEntries(
			Object.entries(this.#state.files).filter(
				([, entry]) => new Date(entry.lastModified).getTime() >= cutoffMs,
			),
		);
	}
}

if (import.meta.vitest != null) {
	describe("CursorStore", () => {
		let tmpDir: string;

		beforeEach(async () => {
			tmpDir = await mkdtemp(join(tmpdir(), "token-racer-cs-test-"));
		});

		afterEach(async () => {
			await rm(tmpDir, { recursive: true, force: true });
		});

		it("returns default state when file does not exist", async () => {
			const store = new CursorStore(join(tmpDir, "cursors.json"));
			const state = await store.load();
			expect(state.version).toBe(1);
			expect(Object.keys(state.files)).toHaveLength(0);
		});

		it("getCursor returns null for unknown path", async () => {
			const store = new CursorStore(join(tmpDir, "cursors.json"));
			await store.load();
			expect(store.getCursor("/nonexistent.jsonl")).toBeNull();
		});

		it("advanceCursor updates in-memory state", async () => {
			const store = new CursorStore(join(tmpDir, "cursors.json"));
			await store.load();

			store.advanceCursor("/projects/foo/bar.jsonl", 1024, 10);

			const cursor = store.getCursor("/projects/foo/bar.jsonl");
			expect(cursor).not.toBeNull();
			expect(cursor?.byteOffset).toBe(1024);
			expect(cursor?.lineCount).toBe(10);
		});

		it("advance → flush → reload survives round-trip", async () => {
			const filePath = join(tmpDir, "cursors.json");
			const store1 = new CursorStore(filePath);
			await store1.load();

			store1.advanceCursor("/projects/abc/session.jsonl", 2048, 25);
			store1.advanceCursor("/projects/xyz/other.jsonl", 512, 5);
			await store1.flush();

			const store2 = new CursorStore(filePath);
			await store2.load();

			const c1 = store2.getCursor("/projects/abc/session.jsonl");
			expect(c1).not.toBeNull();
			expect(c1?.byteOffset).toBe(2048);
			expect(c1?.lineCount).toBe(25);

			const c2 = store2.getCursor("/projects/xyz/other.jsonl");
			expect(c2).not.toBeNull();
			expect(c2?.byteOffset).toBe(512);
			expect(c2?.lineCount).toBe(5);
		});

		it("flush writes atomically via .tmp rename", async () => {
			const filePath = join(tmpDir, "cursors.json");
			const store = new CursorStore(filePath);
			await store.load();
			store.advanceCursor("/some/file.jsonl", 100, 2);
			await store.flush();

			// .tmp file must be gone; the real file must exist
			await expect(access(filePath + ".tmp")).rejects.toThrow();
			await expect(access(filePath)).resolves.toBeUndefined();
		});

		it("prune removes entries older than maxAgeDays", async () => {
			const filePath = join(tmpDir, "cursors.json");

			const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
			const seed: CursorState = {
				version: 1,
				files: {
					"/old/file.jsonl": { byteOffset: 100, lineCount: 5, lastModified: tenDaysAgo },
					"/new/file.jsonl": {
						byteOffset: 200,
						lineCount: 8,
						lastModified: new Date().toISOString(),
					},
				},
			};
			await writeFile(filePath, JSON.stringify(seed), "utf8");

			const store = new CursorStore(filePath);
			await store.load();

			store.prune(7);

			expect(store.getCursor("/old/file.jsonl")).toBeNull();
			expect(store.getCursor("/new/file.jsonl")).not.toBeNull();
		});
	});
}
