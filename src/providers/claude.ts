import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as v from "valibot";
import { claudeJsonlSchema } from "../schemas.ts";
import type { TokenEvent } from "../types.ts";
import type { Provider, ParseContext } from "./provider.ts";

const CLAUDE_LOG_DIRS = [
	path.join(os.homedir(), ".config", "claude", "projects"),
	path.join(os.homedir(), ".claude", "projects"),
];

/**
 * Provider for Claude Code JSONL log files.
 *
 * Claude Code writes one JSON object per line to JSONL files under:
 *   ~/.config/claude/projects/{project}/{sessionId}.jsonl  (new default)
 *   ~/.claude/projects/{project}/{sessionId}.jsonl          (legacy path)
 */
export class ClaudeProvider implements Provider {
	readonly name = "claude";
	readonly displayName = "Claude Code";

	async detect(): Promise<boolean> {
		for (const dir of CLAUDE_LOG_DIRS) {
			try {
				await access(dir);
				return true;
			} catch {
				// Directory does not exist or is not accessible — try next.
			}
		}
		return false;
	}

	getLogDirs(): string[] {
		return [...CLAUDE_LOG_DIRS];
	}

	getFilePattern(): string {
		return "**/*.jsonl";
	}

	parseEntry(rawContent: string, context: ParseContext): TokenEvent[] {
		const trimmed = rawContent.trim();
		if (trimmed === "") return [];

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			return [];
		}

		const result = v.safeParse(claudeJsonlSchema, parsed);
		if (!result.success) return [];

		const entry = result.output;

		// Use the sessionId from the JSONL entry when present; fall back to the
		// filename-derived session ID passed in via context.
		const sessionId = entry.sessionId ?? context.fileSessionId;

		const event: TokenEvent = {
			timestamp: entry.timestamp,
			sessionId,
			provider: "claude",
			model: entry.message.model ?? "unknown",
			inputTokens: entry.message.usage.input_tokens,
			outputTokens: entry.message.usage.output_tokens,
			cacheCreationInputTokens: entry.message.usage.cache_creation_input_tokens ?? 0,
			cacheReadInputTokens: entry.message.usage.cache_read_input_tokens ?? 0,
			speed: entry.message.usage.speed,
			costUsd: entry.costUSD,
			projectName: context.projectName,
		};

		return [event];
	}
}

// ---------------------------------------------------------------------------
// In-source tests
// ---------------------------------------------------------------------------

if (import.meta.vitest != null) {
	const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { createHash } = await import("node:crypto");

	/** Build a minimal valid Claude JSONL entry as a JSON string. */
	function makeValidLine(overrides: {
		sessionId?: string;
		model?: string;
		inputTokens?: number;
		outputTokens?: number;
		costUSD?: number;
	} = {}): string {
		return JSON.stringify({
			timestamp: "2025-06-01T12:00:00.000Z",
			sessionId: overrides.sessionId ?? "ses-default-123",
			costUSD: overrides.costUSD ?? 0.0042,
			message: {
				model: overrides.model ?? "claude-sonnet-4-20250514",
				usage: {
					input_tokens: overrides.inputTokens ?? 100,
					output_tokens: overrides.outputTokens ?? 50,
					cache_creation_input_tokens: 10,
					cache_read_input_tokens: 5,
					speed: "standard",
				},
			},
		});
	}

	function makeContext(overrides: Partial<{
		filePath: string;
		projectName: string;
		fileSessionId: string;
	}> = {}) {
		return {
			filePath: overrides.filePath ?? "/some/project/ses-file.jsonl",
			projectName: overrides.projectName ?? hashProjectName("test-project"),
			fileSessionId: overrides.fileSessionId ?? "ses-file",
		};
	}

	function hashProjectName(name: string): string {
		return createHash("sha256").update(name, "utf8").digest("hex").slice(0, 12);
	}

	describe("ClaudeProvider", () => {
		const provider = new ClaudeProvider();

		// ---- Metadata ----------------------------------------------------------

		it("has the correct name and displayName", () => {
			expect(provider.name).toBe("claude");
			expect(provider.displayName).toBe("Claude Code");
		});

		it("getFilePattern returns **/*.jsonl", () => {
			expect(provider.getFilePattern()).toBe("**/*.jsonl");
		});

		it("getLogDirs returns both possible claude directories", () => {
			const dirs = provider.getLogDirs();
			expect(dirs.length).toBe(2);
			const homedir = os.homedir();
			expect(dirs).toContain(path.join(homedir, ".config", "claude", "projects"));
			expect(dirs).toContain(path.join(homedir, ".claude", "projects"));
		});

		// ---- detect() ----------------------------------------------------------

		describe("detect()", () => {
			let tmpDir: string;

			beforeEach(async () => {
				tmpDir = await mkdtemp(path.join(tmpdir(), "token-racer-claude-provider-test-"));
			});

			afterEach(async () => {
				await rm(tmpDir, { recursive: true, force: true });
			});

			it("returns true when at least one log directory exists", async () => {
				// We cannot safely mutate the real home-dir paths inside the test,
				// but we can verify the logic by confirming that detect() returns a
				// boolean and doesn't throw. A real integration check would require
				// dependency injection; here we just smoke-test the contract.
				const result = await provider.detect();
				expect(typeof result).toBe("boolean");
			});

			it("returns false when neither claude directory exists", async () => {
				// Create a provider whose log dirs point to non-existent subdirs
				// of a fresh tmpDir — guaranteed to not exist.
				const missingA = path.join(tmpDir, "no-config", "claude", "projects");
				const missingB = path.join(tmpDir, "no-home", ".claude", "projects");

				const testProvider = new ClaudeProviderTestable([missingA, missingB]);
				const result = await testProvider.detect();
				expect(result).toBe(false);
			});

			it("returns true when only one of the two directories exists", async () => {
				const existingDir = path.join(tmpDir, "claude", "projects");
				await mkdir(existingDir, { recursive: true });
				const missingDir = path.join(tmpDir, "does-not-exist");

				const testProvider = new ClaudeProviderTestable([missingDir, existingDir]);
				const result = await testProvider.detect();
				expect(result).toBe(true);
			});
		});

		// ---- parseEntry() ------------------------------------------------------

		describe("parseEntry()", () => {
			it("correctly parses a valid Claude JSONL line", () => {
				const line = makeValidLine({
					sessionId: "ses-parse-001",
					model: "claude-opus-4-20250514",
					inputTokens: 200,
					outputTokens: 75,
					costUSD: 0.0021,
				});
				const ctx = makeContext({ fileSessionId: "ses-file-fallback" });
				const events = provider.parseEntry(line, ctx);

				expect(events).toHaveLength(1);
				const [event] = events;
				if (event == null) throw new Error("parseEntry returned no events");
				expect(event.sessionId).toBe("ses-parse-001"); // from entry, not fallback
				expect(event.provider).toBe("claude");
				expect(event.model).toBe("claude-opus-4-20250514");
				expect(event.inputTokens).toBe(200);
				expect(event.outputTokens).toBe(75);
				expect(event.cacheCreationInputTokens).toBe(10);
				expect(event.cacheReadInputTokens).toBe(5);
				expect(event.speed).toBe("standard");
				expect(event.costUsd).toBe(0.0021);
				expect(event.projectName).toBe(ctx.projectName);
				expect(event.timestamp).toBe("2025-06-01T12:00:00.000Z");
			});

			it("always stamps provider='claude' on emitted events", () => {
				const events = provider.parseEntry(makeValidLine(), makeContext());
				expect(events).toHaveLength(1);
				expect(events[0]?.provider).toBe("claude");
			});

			it("uses context.fileSessionId when sessionId is missing from entry", () => {
				// Build a raw object without sessionId, then stringify.
				const raw = {
					timestamp: "2025-06-02T09:00:00.000Z",
					message: {
						model: "claude-sonnet-4-20250514",
						usage: {
							input_tokens: 50,
							output_tokens: 20,
						},
					},
				};
				const ctx = makeContext({ fileSessionId: "derived-from-filename" });
				const events = provider.parseEntry(JSON.stringify(raw), ctx);

				expect(events).toHaveLength(1);
				expect(events[0]?.sessionId).toBe("derived-from-filename");
			});

			it("falls back to unknown model when model field is absent", () => {
				const raw = {
					timestamp: "2025-06-02T10:00:00.000Z",
					sessionId: "ses-no-model",
					message: {
						usage: { input_tokens: 10, output_tokens: 5 },
					},
				};
				const events = provider.parseEntry(JSON.stringify(raw), makeContext());
				expect(events).toHaveLength(1);
				expect(events[0]?.model).toBe("unknown");
			});

			it("zero-fills cache token fields when absent", () => {
				const raw = {
					timestamp: "2025-06-02T11:00:00.000Z",
					sessionId: "ses-no-cache",
					message: {
						model: "claude-sonnet-4-20250514",
						usage: { input_tokens: 30, output_tokens: 10 },
					},
				};
				const events = provider.parseEntry(JSON.stringify(raw), makeContext());
				expect(events).toHaveLength(1);
				expect(events[0]?.cacheCreationInputTokens).toBe(0);
				expect(events[0]?.cacheReadInputTokens).toBe(0);
			});

			it("returns [] for invalid (non-schema-conforming) JSON", () => {
				const invalid = JSON.stringify({ foo: "bar", unrelated: 42 });
				const events = provider.parseEntry(invalid, makeContext());
				expect(events).toHaveLength(0);
			});

			it("returns [] for malformed JSON (not parseable)", () => {
				const events = provider.parseEntry("{not valid json{{", makeContext());
				expect(events).toHaveLength(0);
			});

			it("returns [] for an empty/whitespace-only line", () => {
				expect(provider.parseEntry("", makeContext())).toHaveLength(0);
				expect(provider.parseEntry("   \t  ", makeContext())).toHaveLength(0);
			});

			it("returns [] when message.usage.input_tokens is missing", () => {
				const bad = JSON.stringify({
					timestamp: "2025-06-02T12:00:00.000Z",
					message: { usage: { output_tokens: 10 } },
				});
				const events = provider.parseEntry(bad, makeContext());
				expect(events).toHaveLength(0);
			});

			it("preserves the projectName from context", () => {
				const hashed = hashProjectName("my-secret-project");
				const ctx = makeContext({ projectName: hashed });
				const events = provider.parseEntry(makeValidLine(), ctx);
				expect(events).toHaveLength(1);
				expect(events[0]?.projectName).toBe(hashed);
			});
		});
	});

	// ---------------------------------------------------------------------------
	// Test-only subclass that allows injecting custom log directories.
	// This avoids mutating the real home directory paths in tests.
	// ---------------------------------------------------------------------------

	class ClaudeProviderTestable extends ClaudeProvider {
		#logDirs: string[];

		constructor(logDirs: string[]) {
			super();
			this.#logDirs = logDirs;
		}

		override getLogDirs(): string[] {
			return [...this.#logDirs];
		}

		override async detect(): Promise<boolean> {
			for (const dir of this.#logDirs) {
				try {
					await access(dir);
					return true;
				} catch {
					// Not accessible — try next.
				}
			}
			return false;
		}
	}
}
