import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { TokenEvent } from "../types.ts";
import type { Provider, ParseContext } from "../providers/provider.ts";

export type TailResult = {
	events: TokenEvent[];
	newByteOffset: number;
	newLineCount: number;
	/**
	 * True when we hit `maxBytes` before reaching EOF and there are more bytes
	 * to read on a subsequent call. Callers can use this to decide whether to
	 * re-queue the same file for another pass within the same sync.
	 */
	moreAvailable: boolean;
};

export type TailOptions = {
	/** Cap on bytes read past `fromByteOffset`. Prevents OOM on huge catch-up. */
	maxBytes?: number;
};

/**
 * Hashes a project directory name with SHA-256 and returns the first 12
 * hex characters. This is used instead of the raw path for privacy.
 */
export function hashProjectName(rawName: string): string {
	return createHash("sha256").update(rawName, "utf8").digest("hex").slice(0, 12);
}

/**
 * Extracts and hashes the project name from a JSONL file path.
 *
 * Log files are written to:
 *   {baseDir}/projects/{project}/{sessionId}.jsonl
 *
 * The project name is the directory immediately above the log file.
 */
export function projectNameFromPath(filePath: string): string {
	const projectDir = path.basename(path.dirname(filePath));
	return hashProjectName(projectDir);
}

/**
 * Reads a stream into a single string.
 */
function readStreamToString(stream: ReturnType<typeof createReadStream>): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const chunks: Buffer[] = [];
		stream.on("data", (chunk: Buffer | string) => {
			chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
		});
		stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		stream.on("error", reject);
	});
}

/**
 * Reads new bytes from `filePath` starting at `fromByteOffset`, parses
 * complete JSONL lines, and delegates parsing to the given provider.
 *
 * Partial lines at EOF are handled correctly: if the chunk doesn't end
 * with a newline the last incomplete segment is held back, and
 * `newByteOffset` only advances past bytes that correspond to complete
 * lines (including their trailing `\n`).
 *
 * File rotation (size < fromByteOffset) causes a full reset to offset 0.
 */
export async function tailFile(
	filePath: string,
	fromByteOffset: number,
	currentLineCount: number,
	provider: Provider,
	options: TailOptions = {},
): Promise<TailResult> {
	// ---- Guard: file rotation ------------------------------------------------
	let fileStat: Awaited<ReturnType<typeof stat>>;
	try {
		fileStat = await stat(filePath);
	} catch {
		// File gone — reset.
		return { events: [], newByteOffset: 0, newLineCount: 0, moreAvailable: false };
	}

	if (fileStat.size < fromByteOffset) {
		// File was truncated or rotated.
		return { events: [], newByteOffset: 0, newLineCount: 0, moreAvailable: fileStat.size > 0 };
	}

	if (fileStat.size === fromByteOffset) {
		// Nothing new to read.
		return {
			events: [],
			newByteOffset: fromByteOffset,
			newLineCount: currentLineCount,
			moreAvailable: false,
		};
	}

	// ---- Determine byte range ------------------------------------------------
	const totalRemaining = fileStat.size - fromByteOffset;
	const maxBytes = options.maxBytes ?? totalRemaining;
	const readBytes = Math.min(totalRemaining, maxBytes);
	const hitCap = readBytes < totalRemaining;

	// ---- Read new bytes ------------------------------------------------------
	// Stream range [start, end] inclusive. `end` is undefined means "to EOF".
	const streamOptions: { start: number; end?: number } = { start: fromByteOffset };
	if (hitCap) {
		streamOptions.end = fromByteOffset + readBytes - 1;
	}
	const stream = createReadStream(filePath, streamOptions);

	let raw: string;
	try {
		raw = await readStreamToString(stream);
	} catch {
		return {
			events: [],
			newByteOffset: fromByteOffset,
			newLineCount: currentLineCount,
			moreAvailable: false,
		};
	}

	// ---- Handle partial last line --------------------------------------------
	// Split on newlines. If the raw content does not end with '\n' the last
	// element is an incomplete line that must not be processed.
	const endsWithNewline = raw.endsWith("\n");
	const allSegments = raw.split("\n");

	// Complete lines are all segments except the trailing empty string that
	// split() produces when the content ends with '\n'.  When the content does
	// NOT end with '\n' the last segment is the partial line — discard it.
	const completeLines: string[] = endsWithNewline
		? allSegments.slice(0, -1) // drop the trailing empty string
		: allSegments.slice(0, -1); // drop the partial last line (same operation)

	// processedContent = only the bytes we intend to count against the offset.
	// Each complete line contributes (line bytes) + 1 byte for the '\n'.
	const processedContent = completeLines.map((l) => l + "\n").join("");
	const newByteOffset = fromByteOffset + Buffer.byteLength(processedContent, "utf8");
	const newLineCount = currentLineCount + completeLines.length;

	// ---- Build parse context -------------------------------------------------
	const context: ParseContext = {
		filePath,
		projectName: projectNameFromPath(filePath),
		fileSessionId: path.basename(filePath, path.extname(filePath)),
	};

	// ---- Parse via provider --------------------------------------------------
	const events: TokenEvent[] = [];

	for (const line of completeLines) {
		const trimmed = line.trim();
		if (trimmed === "") continue;

		const parsed = provider.parseEntry(trimmed, context);
		for (const event of parsed) {
			events.push(event);
		}
	}

	// moreAvailable = true whenever we deliberately stopped short of EOF (either
	// because of maxBytes, or because the last line was incomplete and we need
	// another read once more bytes arrive).
	const moreAvailable = hitCap || (!endsWithNewline && completeLines.length > 0);

	return { events, newByteOffset, newLineCount, moreAvailable };
}

// ---------------------------------------------------------------------------
// In-source tests
// ---------------------------------------------------------------------------

if (import.meta.vitest != null) {
	const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { createHash: _createHash } = await import("node:crypto");
	const { ClaudeProvider } = await import("../providers/claude.ts");

	const SAMPLE_LINE = JSON.stringify({
		timestamp: "2025-06-01T12:00:00.000Z",
		sessionId: "ses-abc",
		costUSD: 0.0012,
		message: {
			model: "claude-sonnet-4-20250514",
			usage: {
				input_tokens: 100,
				output_tokens: 50,
				cache_creation_input_tokens: 10,
				cache_read_input_tokens: 5,
				speed: "standard",
			},
		},
	});

	describe("tailFile", () => {
		let tmpDir: string;
		let claude: InstanceType<typeof ClaudeProvider>;

		beforeEach(async () => {
			tmpDir = await mkdtemp(path.join(tmpdir(), "token-racer-tailer-test-"));
			claude = new ClaudeProvider();
		});

		afterEach(async () => {
			await rm(tmpDir, { recursive: true, force: true });
		});

		it("tails 3 valid lines from offset 0 and returns correct byte offset", async () => {
			const filePath = path.join(tmpDir, "project-alpha", "ses-abc.jsonl");
			await import("node:fs/promises").then((fsp) =>
				fsp.mkdir(path.dirname(filePath), { recursive: true })
			);
			const content = [SAMPLE_LINE, SAMPLE_LINE, SAMPLE_LINE].join("\n") + "\n";
			await writeFile(filePath, content, "utf8");

			const result = await tailFile(filePath, 0, 0, claude);

			expect(result.events).toHaveLength(3);
			expect(result.newByteOffset).toBe(Buffer.byteLength(content, "utf8"));
			expect(result.newLineCount).toBe(3);
			const firstEvent = result.events.at(0);
			expect(firstEvent?.sessionId).toBe("ses-abc");
			expect(firstEvent?.model).toBe("claude-sonnet-4-20250514");
			expect(firstEvent?.inputTokens).toBe(100);
			expect(firstEvent?.outputTokens).toBe(50);
		});

		it("does not include a partial last line and stops offset before it", async () => {
			const filePath = path.join(tmpDir, "proj", "ses-partial.jsonl");
			await import("node:fs/promises").then((fsp) =>
				fsp.mkdir(path.dirname(filePath), { recursive: true })
			);
			const completePart = SAMPLE_LINE + "\n";
			const partialLine = '{"timestamp":"2025-06-01T12:00:01.000Z","message":{"usage":{'; // no closing
			await writeFile(filePath, completePart + partialLine, "utf8");

			const result = await tailFile(filePath, 0, 0, claude);

			expect(result.events).toHaveLength(1);
			// Byte offset must stop after the complete line (including its \n).
			expect(result.newByteOffset).toBe(Buffer.byteLength(completePart, "utf8"));
			expect(result.newLineCount).toBe(1);
		});

		it("skips malformed JSON lines silently", async () => {
			const filePath = path.join(tmpDir, "proj", "ses-malformed.jsonl");
			await import("node:fs/promises").then((fsp) =>
				fsp.mkdir(path.dirname(filePath), { recursive: true })
			);
			const lines = [
				SAMPLE_LINE,
				"not valid json at all {{{",
				SAMPLE_LINE,
			].join("\n") + "\n";
			await writeFile(filePath, lines, "utf8");

			const result = await tailFile(filePath, 0, 0, claude);

			// Malformed line is skipped; the two valid ones remain.
			expect(result.events).toHaveLength(2);
			expect(result.newLineCount).toBe(3); // all 3 lines were consumed
		});

		it("hashes the project name correctly", async () => {
			const projectDir = "my-secret-project";
			const filePath = path.join(tmpDir, projectDir, "ses-hash.jsonl");
			await import("node:fs/promises").then((fsp) =>
				fsp.mkdir(path.dirname(filePath), { recursive: true })
			);
			await writeFile(filePath, SAMPLE_LINE + "\n", "utf8");

			const result = await tailFile(filePath, 0, 0, claude);

			const expectedHash = _createHash("sha256")
				.update(projectDir, "utf8")
				.digest("hex")
				.slice(0, 12);

			expect(result.events).toHaveLength(1);
			const hashedEvent = result.events.at(0);
			expect(hashedEvent?.projectName).toBe(expectedHash);
			// Must NOT equal the raw directory name.
			expect(hashedEvent?.projectName).not.toBe(projectDir);
		});

		it("returns reset (offset 0) when file is smaller than fromByteOffset", async () => {
			const filePath = path.join(tmpDir, "proj", "ses-rotated.jsonl");
			await import("node:fs/promises").then((fsp) =>
				fsp.mkdir(path.dirname(filePath), { recursive: true })
			);
			// Write a small file, then claim we're ahead of its size.
			await writeFile(filePath, "short\n", "utf8");

			const result = await tailFile(filePath, 99999, 50, claude);

			expect(result.events).toHaveLength(0);
			expect(result.newByteOffset).toBe(0);
			expect(result.newLineCount).toBe(0);
			// Rotation leaves behind content — caller should tail the new file next.
			expect(result.moreAvailable).toBe(true);
		});

		it("returns empty events and unchanged offset when nothing is new", async () => {
			const filePath = path.join(tmpDir, "proj", "ses-nothing.jsonl");
			await import("node:fs/promises").then((fsp) =>
				fsp.mkdir(path.dirname(filePath), { recursive: true })
			);
			const content = SAMPLE_LINE + "\n";
			await writeFile(filePath, content, "utf8");
			const size = Buffer.byteLength(content, "utf8");

			const result = await tailFile(filePath, size, 1, claude);

			expect(result.events).toHaveLength(0);
			expect(result.newByteOffset).toBe(size);
			expect(result.newLineCount).toBe(1);
		});

		it("correctly advances offset when reading from a non-zero start", async () => {
			const filePath = path.join(tmpDir, "proj", "ses-incremental.jsonl");
			await import("node:fs/promises").then((fsp) =>
				fsp.mkdir(path.dirname(filePath), { recursive: true })
			);
			const firstLine = SAMPLE_LINE + "\n";
			const secondLine = SAMPLE_LINE + "\n";
			await writeFile(filePath, firstLine + secondLine, "utf8");

			const firstByteLen = Buffer.byteLength(firstLine, "utf8");

			// Simulate having already read the first line.
			const result = await tailFile(filePath, firstByteLen, 1, claude);

			expect(result.events).toHaveLength(1);
			expect(result.newByteOffset).toBe(firstByteLen + Buffer.byteLength(secondLine, "utf8"));
			expect(result.newLineCount).toBe(2);
			expect(result.moreAvailable).toBe(false);
		});

		it("respects maxBytes cap — stops at line boundary inside the cap", async () => {
			const filePath = path.join(tmpDir, "proj", "ses-cap.jsonl");
			await import("node:fs/promises").then((fsp) =>
				fsp.mkdir(path.dirname(filePath), { recursive: true })
			);
			const lineWithNewline = SAMPLE_LINE + "\n";
			const lineBytes = Buffer.byteLength(lineWithNewline, "utf8");
			// 5 lines total.
			await writeFile(filePath, lineWithNewline.repeat(5), "utf8");

			// Cap at 2.5 lines → tailer should consume 2 complete lines, leave 3 behind.
			const cap = Math.floor(lineBytes * 2.5);
			const result = await tailFile(filePath, 0, 0, claude, { maxBytes: cap });

			expect(result.events).toHaveLength(2);
			expect(result.newByteOffset).toBe(lineBytes * 2);
			expect(result.moreAvailable).toBe(true);
		});

		it("moreAvailable=true when the last line is incomplete (no trailing newline)", async () => {
			const filePath = path.join(tmpDir, "proj", "ses-partial-more.jsonl");
			await import("node:fs/promises").then((fsp) =>
				fsp.mkdir(path.dirname(filePath), { recursive: true })
			);
			const completePart = SAMPLE_LINE + "\n";
			const partialLine = '{"timestamp":"X","message":{"usage":{';
			await writeFile(filePath, completePart + partialLine, "utf8");

			const result = await tailFile(filePath, 0, 0, claude);
			expect(result.events).toHaveLength(1);
			expect(result.moreAvailable).toBe(true);
		});
	});
}
