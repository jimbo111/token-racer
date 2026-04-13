import os from "node:os";
import path from "node:path";
import { access } from "node:fs/promises";
import * as v from "valibot";
import { nonNegInt } from "../schemas.ts";
import type { TokenEvent } from "../types.ts";
import type { Provider, ParseContext } from "./provider.ts";

// ---------------------------------------------------------------------------
// Valibot schema
// ---------------------------------------------------------------------------

/**
 * Token usage block found in both `last_token_usage` and `total_token_usage`.
 * All fields are optional since older Codex builds may omit some.
 */
const codexTokenUsageSchema = v.object({
	input_tokens: v.optional(nonNegInt),
	output_tokens: v.optional(nonNegInt),
	cached_input_tokens: v.optional(nonNegInt),
	cache_read_input_tokens: v.optional(nonNegInt),
	reasoning_output_tokens: v.optional(nonNegInt),
	total_tokens: v.optional(nonNegInt),
});

const codexEntrySchema = v.object({
	type: v.string(),
	timestamp: v.optional(v.string()),
	payload: v.optional(
		v.object({
			type: v.optional(v.string()),
			model: v.optional(v.string()),
			metadata: v.optional(
				v.object({
					model: v.optional(v.string()),
				}),
			),
			info: v.optional(
				v.object({
					model: v.optional(v.string()),
					model_name: v.optional(v.string()),
					metadata: v.optional(
						v.object({
							model: v.optional(v.string()),
						}),
					),
					last_token_usage: v.optional(codexTokenUsageSchema),
					total_token_usage: v.optional(codexTokenUsageSchema),
				}),
			),
		}),
	),
});

type CodexEntry = v.InferOutput<typeof codexEntrySchema>;
type CodexTokenUsage = v.InferOutput<typeof codexTokenUsageSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolves the Codex home directory from the environment, defaulting to
 * `~/.codex`.
 */
function resolveCodexHome(): string {
	const envHome = process.env["CODEX_HOME"];
	if (envHome != null && envHome !== "") {
		return envHome;
	}
	return path.join(os.homedir(), ".codex");
}

/**
 * Extracts model name from a parsed Codex entry using the documented
 * priority order:
 *   1. payload.info.model
 *   2. payload.info.model_name
 *   3. payload.info.metadata.model
 *   4. payload.model
 *
 * Falls back to "unknown-codex" if none are present.
 */
function extractModel(entry: CodexEntry): string {
	const info = entry.payload?.info;
	if (info?.model != null && info.model !== "") return info.model;
	if (info?.model_name != null && info.model_name !== "") return info.model_name;
	if (info?.metadata?.model != null && info.metadata.model !== "") return info.metadata.model;
	const payloadModel = entry.payload?.model;
	if (payloadModel != null && payloadModel !== "") return payloadModel;
	return "unknown-codex";
}

/**
 * Reads token counts from a usage block, handling both field naming variants
 * (`cached_input_tokens` and `cache_read_input_tokens`).
 */
function readUsage(usage: CodexTokenUsage): {
	inputTokens: number;
	outputTokens: number;
	cacheCreationInputTokens: number;
	cacheReadInputTokens: number;
} {
	return {
		inputTokens: usage.input_tokens ?? 0,
		outputTokens: usage.output_tokens ?? 0,
		cacheCreationInputTokens: 0, // Codex does not expose cache write counts
		cacheReadInputTokens:
			usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? 0,
	};
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export class CodexProvider implements Provider {
	readonly name = "codex";
	readonly displayName = "OpenAI Codex";

	/**
	 * Returns true when the `~/.codex` directory (or the directory pointed at
	 * by `CODEX_HOME`) is accessible on the file system.
	 */
	async detect(): Promise<boolean> {
		const dir = resolveCodexHome();
		try {
			await access(dir);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Returns the single directory where Codex writes session JSONL files.
	 */
	getLogDirs(): string[] {
		return [path.join(resolveCodexHome(), "sessions")];
	}

	/**
	 * Codex writes multiple JSON objects per file, one per line (JSONL).
	 */
	getFilePattern(): string {
		return "**/*.jsonl";
	}

	/**
	 * Parses a single JSONL line from a Codex session file.
	 *
	 * Only lines where `payload.type === "token_count"` are processed.
	 * Token deltas are taken from `payload.info.last_token_usage` when
	 * present; otherwise `payload.info.total_token_usage` is used.
	 *
	 * Returns an empty array for any line that is not a token_count event,
	 * fails schema validation, or contains only zero tokens.
	 */
	parseEntry(rawContent: string, context: ParseContext): TokenEvent[] {
		const trimmed = rawContent.trim();
		if (trimmed === "") return [];

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			return [];
		}

		const result = v.safeParse(codexEntrySchema, parsed);
		if (!result.success) return [];

		const entry = result.output;

		// Only process token_count events.
		if (entry.payload?.type !== "token_count") return [];

		const info = entry.payload.info;
		if (info == null) return [];

		// Prefer per-turn delta; fall back to cumulative total.
		const usageBlock = info.last_token_usage ?? info.total_token_usage;
		if (usageBlock == null) return [];

		const { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens } =
			readUsage(usageBlock);

		// Skip entries that carry no meaningful token data.
		if (inputTokens === 0 && outputTokens === 0) return [];

		const model = extractModel(entry);

		// Timestamp: use the entry's own timestamp if present, otherwise fall
		// back to the current time expressed as an ISO-8601 string.
		const timestamp = entry.timestamp ?? new Date().toISOString();

		const event: TokenEvent = {
			timestamp,
			sessionId: context.fileSessionId,
			provider: "codex",
			model,
			inputTokens,
			outputTokens,
			cacheCreationInputTokens,
			cacheReadInputTokens,
			projectName: context.projectName,
		};

		return [event];
	}
}

// ---------------------------------------------------------------------------
// In-source tests
// ---------------------------------------------------------------------------

if (import.meta.vitest != null) {
	const PROVIDER = new CodexProvider();

	const PARSE_CONTEXT: ParseContext = {
		filePath: "/home/user/.codex/sessions/proj/ses-abc.jsonl",
		projectName: "hashed-project-name",
		fileSessionId: "ses-abc",
	};

	const makeTokenCountLine = (overrides?: {
		timestamp?: string;
		last_token_usage?: Record<string, number>;
		total_token_usage?: Record<string, number>;
		model?: string;
		infoModel?: string;
	}): string => {
		const entry = {
			type: "event_msg",
			timestamp: overrides?.timestamp ?? "2025-06-01T12:00:00.000Z",
			payload: {
				type: "token_count",
				model: overrides?.model,
				info: {
					model: overrides?.infoModel,
					last_token_usage: overrides?.last_token_usage ?? {
						input_tokens: 100,
						output_tokens: 50,
						cached_input_tokens: 20,
					},
					total_token_usage: overrides?.total_token_usage,
				},
			},
		};
		return JSON.stringify(entry);
	};

	describe("CodexProvider.parseEntry", () => {
		it("returns 1 TokenEvent for a valid token_count line", () => {
			const events = PROVIDER.parseEntry(makeTokenCountLine(), PARSE_CONTEXT);
			expect(events).toHaveLength(1);
			const event = events[0];
			expect(event?.provider).toBe("codex");
			expect(event?.inputTokens).toBe(100);
			expect(event?.outputTokens).toBe(50);
			expect(event?.cacheReadInputTokens).toBe(20);
			expect(event?.sessionId).toBe("ses-abc");
			expect(event?.projectName).toBe("hashed-project-name");
		});

		it("always stamps provider='codex' on emitted events", () => {
			const events = PROVIDER.parseEntry(makeTokenCountLine(), PARSE_CONTEXT);
			expect(events).toHaveLength(1);
			expect(events[0]?.provider).toBe("codex");
		});

		it("returns [] for a non-token_count line", () => {
			const line = JSON.stringify({
				type: "event_msg",
				payload: { type: "other_event", info: {} },
			});
			expect(PROVIDER.parseEntry(line, PARSE_CONTEXT)).toHaveLength(0);
		});

		it("returns [] for an empty line", () => {
			expect(PROVIDER.parseEntry("", PARSE_CONTEXT)).toHaveLength(0);
			expect(PROVIDER.parseEntry("   ", PARSE_CONTEXT)).toHaveLength(0);
		});

		it("returns [] for malformed JSON", () => {
			expect(PROVIDER.parseEntry("{not valid json", PARSE_CONTEXT)).toHaveLength(0);
		});

		it("returns [] when both inputTokens and outputTokens are 0", () => {
			const line = makeTokenCountLine({
				last_token_usage: { input_tokens: 0, output_tokens: 0 },
			});
			expect(PROVIDER.parseEntry(line, PARSE_CONTEXT)).toHaveLength(0);
		});

		it("prefers last_token_usage over total_token_usage", () => {
			const line = makeTokenCountLine({
				last_token_usage: { input_tokens: 10, output_tokens: 5 },
				total_token_usage: { input_tokens: 9999, output_tokens: 9999 },
			});
			const events = PROVIDER.parseEntry(line, PARSE_CONTEXT);
			expect(events).toHaveLength(1);
			expect(events[0]?.inputTokens).toBe(10);
			expect(events[0]?.outputTokens).toBe(5);
		});

		it("falls back to total_token_usage when last_token_usage is absent", () => {
			const entry = {
				type: "event_msg",
				timestamp: "2025-06-01T12:00:00.000Z",
				payload: {
					type: "token_count",
					info: {
						total_token_usage: {
							input_tokens: 500,
							output_tokens: 200,
						},
					},
				},
			};
			const events = PROVIDER.parseEntry(JSON.stringify(entry), PARSE_CONTEXT);
			expect(events).toHaveLength(1);
			expect(events[0]?.inputTokens).toBe(500);
			expect(events[0]?.outputTokens).toBe(200);
		});

		it("maps cache_read_input_tokens field name", () => {
			const line = makeTokenCountLine({
				last_token_usage: {
					input_tokens: 50,
					output_tokens: 25,
					cache_read_input_tokens: 15,
				},
			});
			const events = PROVIDER.parseEntry(line, PARSE_CONTEXT);
			expect(events[0]?.cacheReadInputTokens).toBe(15);
		});

		it("prefers cached_input_tokens as fallback when cache_read_input_tokens is absent", () => {
			const line = makeTokenCountLine({
				last_token_usage: {
					input_tokens: 50,
					output_tokens: 25,
					cached_input_tokens: 8,
				},
			});
			const events = PROVIDER.parseEntry(line, PARSE_CONTEXT);
			expect(events[0]?.cacheReadInputTokens).toBe(8);
		});

		describe("model extraction priority", () => {
			it("uses payload.info.model first", () => {
				const entry = {
					type: "event_msg",
					timestamp: "2025-06-01T12:00:00.000Z",
					payload: {
						type: "token_count",
						model: "payload-model",
						info: {
							model: "info-model",
							model_name: "info-model-name",
							last_token_usage: { input_tokens: 1, output_tokens: 1 },
						},
					},
				};
				const events = PROVIDER.parseEntry(JSON.stringify(entry), PARSE_CONTEXT);
				expect(events[0]?.model).toBe("info-model");
			});

			it("falls back to payload.info.model_name when info.model is absent", () => {
				const entry = {
					type: "event_msg",
					timestamp: "2025-06-01T12:00:00.000Z",
					payload: {
						type: "token_count",
						model: "payload-model",
						info: {
							model_name: "info-model-name",
							last_token_usage: { input_tokens: 1, output_tokens: 1 },
						},
					},
				};
				const events = PROVIDER.parseEntry(JSON.stringify(entry), PARSE_CONTEXT);
				expect(events[0]?.model).toBe("info-model-name");
			});

			it("falls back to payload.info.metadata.model", () => {
				const entry = {
					type: "event_msg",
					timestamp: "2025-06-01T12:00:00.000Z",
					payload: {
						type: "token_count",
						info: {
							metadata: { model: "metadata-model" },
							last_token_usage: { input_tokens: 1, output_tokens: 1 },
						},
					},
				};
				const events = PROVIDER.parseEntry(JSON.stringify(entry), PARSE_CONTEXT);
				expect(events[0]?.model).toBe("metadata-model");
			});

			it("falls back to payload.model", () => {
				const entry = {
					type: "event_msg",
					timestamp: "2025-06-01T12:00:00.000Z",
					payload: {
						type: "token_count",
						model: "payload-model",
						info: {
							last_token_usage: { input_tokens: 1, output_tokens: 1 },
						},
					},
				};
				const events = PROVIDER.parseEntry(JSON.stringify(entry), PARSE_CONTEXT);
				expect(events[0]?.model).toBe("payload-model");
			});

			it("falls back to unknown-codex when no model field is present", () => {
				const entry = {
					type: "event_msg",
					timestamp: "2025-06-01T12:00:00.000Z",
					payload: {
						type: "token_count",
						info: {
							last_token_usage: { input_tokens: 1, output_tokens: 1 },
						},
					},
				};
				const events = PROVIDER.parseEntry(JSON.stringify(entry), PARSE_CONTEXT);
				expect(events[0]?.model).toBe("unknown-codex");
			});
		});

		it("uses entry timestamp when present", () => {
			const ts = "2025-07-15T08:30:00.000Z";
			const events = PROVIDER.parseEntry(makeTokenCountLine({ timestamp: ts }), PARSE_CONTEXT);
			expect(events[0]?.timestamp).toBe(ts);
		});

		it("falls back to a non-empty ISO string when timestamp is absent", () => {
			const entry = {
				type: "event_msg",
				payload: {
					type: "token_count",
					info: {
						last_token_usage: { input_tokens: 1, output_tokens: 1 },
					},
				},
			};
			const events = PROVIDER.parseEntry(JSON.stringify(entry), PARSE_CONTEXT);
			expect(events).toHaveLength(1);
			expect(events[0]?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		});
	});

	describe("CodexProvider.getLogDirs", () => {
		it("returns a path ending in 'sessions' under CODEX_HOME", () => {
			const dirs = PROVIDER.getLogDirs();
			expect(dirs).toHaveLength(1);
			expect(dirs[0]).toContain("sessions");
		});
	});

	describe("CodexProvider.getFilePattern", () => {
		it("returns a JSONL glob", () => {
			expect(PROVIDER.getFilePattern()).toBe("**/*.jsonl");
		});
	});

	describe("CodexProvider.detect", () => {
		it("returns false for a directory that does not exist", async () => {
			// Point CODEX_HOME at a path that should never exist.
			const original = process.env["CODEX_HOME"];
			process.env["CODEX_HOME"] = "/nonexistent-path-token-racer-test-codex-xyz";
			try {
				const result = await PROVIDER.detect();
				expect(result).toBe(false);
			} finally {
				if (original === undefined) {
					delete process.env["CODEX_HOME"];
				} else {
					process.env["CODEX_HOME"] = original;
				}
			}
		});

		it("returns true for a directory that exists (os.homedir)", async () => {
			// os.homedir() is guaranteed to exist on any system running the tests.
			const original = process.env["CODEX_HOME"];
			process.env["CODEX_HOME"] = os.homedir();
			try {
				const result = await PROVIDER.detect();
				expect(result).toBe(true);
			} finally {
				if (original === undefined) {
					delete process.env["CODEX_HOME"];
				} else {
					process.env["CODEX_HOME"] = original;
				}
			}
		});
	});
}
