import * as v from "valibot";

/**
 * Token counts are always non-negative integers. Use this for every
 * `*_tokens` field on any provider schema so pathological log entries
 * (negatives, floats) get dropped at parse time instead of being sent to
 * the backend which would reject the batch with a 400 (non-retryable).
 */
export const nonNegInt = v.pipe(v.number(), v.integer(), v.minValue(0));

/**
 * Valibot schema for a raw Claude Code JSONL line.
 *
 * Claude Code writes one JSON object per line. The structure of interest
 * is an "assistant" turn that carries token usage inside message.usage.
 * Fields that are absent in older versions are marked optional.
 */
export const claudeJsonlSchema = v.object({
	timestamp: v.string(),
	sessionId: v.optional(v.string()),
	costUSD: v.optional(v.number()),
	message: v.object({
		model: v.optional(v.string()),
		usage: v.object({
			input_tokens: nonNegInt,
			output_tokens: nonNegInt,
			cache_creation_input_tokens: v.optional(nonNegInt),
			cache_read_input_tokens: v.optional(nonNegInt),
			speed: v.optional(v.picklist(["standard", "fast"])),
		}),
	}),
});

export type ClaudeJsonlEntry = v.InferOutput<typeof claudeJsonlSchema>;

/**
 * Valibot schema for the flattened TokenEvent shape that the daemon
 * assembles from a raw JSONL entry and the file path context.
 */
export const providerSchema = v.picklist(["claude", "codex", "opencode"]);

export const tokenEventSchema = v.object({
	timestamp: v.string(),
	sessionId: v.string(),
	provider: providerSchema,
	model: v.string(),
	inputTokens: nonNegInt,
	outputTokens: nonNegInt,
	cacheCreationInputTokens: nonNegInt,
	cacheReadInputTokens: nonNegInt,
	speed: v.optional(v.picklist(["standard", "fast"])),
	costUsd: v.optional(v.number()),
	projectName: v.optional(v.string()),
});

export type TokenEventValidated = v.InferOutput<typeof tokenEventSchema>;

/**
 * Valibot schema for a signed batch sent to the backend API.
 */
export const batchPayloadSchema = v.object({
	version: v.literal(1),
	batchId: v.pipe(v.string(), v.minLength(1)),
	keyId: v.pipe(v.string(), v.minLength(1)),
	timestamp: v.string(),
	events: v.array(tokenEventSchema),
	signature: v.pipe(v.string(), v.minLength(1)),
});

export type BatchPayloadValidated = v.InferOutput<typeof batchPayloadSchema>;

/**
 * Valibot schema for the on-disk cursor state that tracks how far the
 * daemon has read into each JSONL file.
 */
export const cursorStateSchema = v.object({
	version: v.literal(1),
	files: v.record(
		v.string(),
		v.object({
			byteOffset: v.pipe(v.number(), v.integer(), v.minValue(0)),
			lineCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
			lastModified: v.string(),
		}),
	),
});

export type CursorStateValidated = v.InferOutput<typeof cursorStateSchema>;

/**
 * Valibot schema for the daemon's user-editable config file.
 */
export const daemonConfigSchema = v.object({
	apiUrl: v.pipe(v.string(), v.url()),
	apiKey: v.optional(v.string()),
});

export type DaemonConfigValidated = v.InferOutput<typeof daemonConfigSchema>;

// ---------------------------------------------------------------------------
// In-source tests
// ---------------------------------------------------------------------------

if (import.meta.vitest != null) {
	describe("claudeJsonlSchema", () => {
		const sampleLine = {
			timestamp: "2025-06-01T12:00:00.000Z",
			sessionId: "abc-session-001",
			costUSD: 0.0042,
			message: {
				model: "claude-sonnet-4-20250514",
				usage: {
					input_tokens: 1024,
					output_tokens: 256,
					cache_creation_input_tokens: 128,
					cache_read_input_tokens: 64,
					speed: "standard" as const,
				},
			},
		};

		it("parses a complete valid JSONL line", () => {
			const result = v.safeParse(claudeJsonlSchema, sampleLine);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.output.sessionId).toBe("abc-session-001");
				expect(result.output.message.usage.input_tokens).toBe(1024);
				expect(result.output.message.usage.speed).toBe("standard");
				expect(result.output.costUSD).toBe(0.0042);
			}
		});

		it("accepts a line without optional fields", () => {
			const minimal = {
				timestamp: "2025-06-01T12:00:00.000Z",
				message: {
					usage: {
						input_tokens: 500,
						output_tokens: 100,
					},
				},
			};
			const result = v.safeParse(claudeJsonlSchema, minimal);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.output.sessionId).toBeUndefined();
				expect(result.output.message.model).toBeUndefined();
				expect(result.output.message.usage.cache_creation_input_tokens).toBeUndefined();
				expect(result.output.message.usage.speed).toBeUndefined();
			}
		});

		it("rejects a line missing message.usage.input_tokens", () => {
			const bad = {
				timestamp: "2025-06-01T12:00:00.000Z",
				message: {
					usage: {
						output_tokens: 100,
					},
				},
			};
			const result = v.safeParse(claudeJsonlSchema, bad);
			expect(result.success).toBe(false);
		});

		it("rejects an invalid speed value", () => {
			const bad = {
				...sampleLine,
				message: {
					...sampleLine.message,
					usage: { ...sampleLine.message.usage, speed: "turbo" },
				},
			};
			const result = v.safeParse(claudeJsonlSchema, bad);
			expect(result.success).toBe(false);
		});
	});

	describe("tokenEventSchema — parse + flatten round-trip", () => {
		/**
		 * Simulates what the daemon does: parse a raw JSONL entry with
		 * claudeJsonlSchema, flatten it into a TokenEvent, then validate
		 * the result with tokenEventSchema.
		 */
		function flattenToTokenEvent(raw: ClaudeJsonlEntry, sessionId: string, projectName?: string) {
			return {
				timestamp: raw.timestamp,
				sessionId,
				provider: "claude" as const,
				model: raw.message.model ?? "unknown",
				inputTokens: raw.message.usage.input_tokens,
				outputTokens: raw.message.usage.output_tokens,
				cacheCreationInputTokens: raw.message.usage.cache_creation_input_tokens ?? 0,
				cacheReadInputTokens: raw.message.usage.cache_read_input_tokens ?? 0,
				speed: raw.message.usage.speed,
				costUsd: raw.costUSD,
				projectName,
			};
		}

		it("round-trips a complete entry", () => {
			const rawEntry: ClaudeJsonlEntry = {
				timestamp: "2025-06-01T14:30:00.000Z",
				sessionId: "ses-round-trip",
				costUSD: 0.0021,
				message: {
					model: "claude-opus-4-20250514",
					usage: {
						input_tokens: 2048,
						output_tokens: 512,
						cache_creation_input_tokens: 256,
						cache_read_input_tokens: 128,
						speed: "fast",
					},
				},
			};

			const flattened = flattenToTokenEvent(rawEntry, "ses-round-trip", "my-project");
			const result = v.safeParse(tokenEventSchema, flattened);

			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.output.sessionId).toBe("ses-round-trip");
				expect(result.output.model).toBe("claude-opus-4-20250514");
				expect(result.output.inputTokens).toBe(2048);
				expect(result.output.outputTokens).toBe(512);
				expect(result.output.cacheCreationInputTokens).toBe(256);
				expect(result.output.cacheReadInputTokens).toBe(128);
				expect(result.output.speed).toBe("fast");
				expect(result.output.costUsd).toBe(0.0021);
				expect(result.output.projectName).toBe("my-project");
			}
		});

		it("round-trips a minimal entry with zero-filled caches", () => {
			const rawEntry: ClaudeJsonlEntry = {
				timestamp: "2025-06-02T09:00:00.000Z",
				message: {
					usage: {
						input_tokens: 100,
						output_tokens: 50,
					},
				},
			};

			const flattened = flattenToTokenEvent(rawEntry, "ses-minimal");
			const result = v.safeParse(tokenEventSchema, flattened);

			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.output.model).toBe("unknown");
				expect(result.output.cacheCreationInputTokens).toBe(0);
				expect(result.output.cacheReadInputTokens).toBe(0);
				expect(result.output.costUsd).toBeUndefined();
				expect(result.output.projectName).toBeUndefined();
			}
		});

		it("rejects a TokenEvent with negative token counts", () => {
			const bad = {
				timestamp: "2025-06-02T09:00:00.000Z",
				sessionId: "ses-bad",
				provider: "claude",
				model: "claude-sonnet-4-20250514",
				inputTokens: -1,
				outputTokens: 50,
				cacheCreationInputTokens: 0,
				cacheReadInputTokens: 0,
			};
			const result = v.safeParse(tokenEventSchema, bad);
			expect(result.success).toBe(false);
		});

		it("rejects a TokenEvent with a non-integer token count", () => {
			const bad = {
				timestamp: "2025-06-02T09:00:00.000Z",
				sessionId: "ses-bad",
				provider: "claude",
				model: "claude-sonnet-4-20250514",
				inputTokens: 1.5,
				outputTokens: 50,
				cacheCreationInputTokens: 0,
				cacheReadInputTokens: 0,
			};
			const result = v.safeParse(tokenEventSchema, bad);
			expect(result.success).toBe(false);
		});

		it("rejects a TokenEvent missing the provider field", () => {
			const bad = {
				timestamp: "2025-06-02T09:00:00.000Z",
				sessionId: "ses-bad",
				model: "claude-sonnet-4-20250514",
				inputTokens: 10,
				outputTokens: 5,
				cacheCreationInputTokens: 0,
				cacheReadInputTokens: 0,
			};
			const result = v.safeParse(tokenEventSchema, bad);
			expect(result.success).toBe(false);
		});

		it("rejects a TokenEvent with an unknown provider value", () => {
			const bad = {
				timestamp: "2025-06-02T09:00:00.000Z",
				sessionId: "ses-bad",
				provider: "unknown-tool",
				model: "claude-sonnet-4-20250514",
				inputTokens: 10,
				outputTokens: 5,
				cacheCreationInputTokens: 0,
				cacheReadInputTokens: 0,
			};
			const result = v.safeParse(tokenEventSchema, bad);
			expect(result.success).toBe(false);
		});

		it("accepts each known provider value", () => {
			for (const provider of ["claude", "codex", "opencode"] as const) {
				const ok = {
					timestamp: "2025-06-02T09:00:00.000Z",
					sessionId: "ses-ok",
					provider,
					model: "some-model",
					inputTokens: 10,
					outputTokens: 5,
					cacheCreationInputTokens: 0,
					cacheReadInputTokens: 0,
				};
				const result = v.safeParse(tokenEventSchema, ok);
				expect(result.success).toBe(true);
			}
		});
	});

	describe("batchPayloadSchema", () => {
		it("validates a well-formed batch", () => {
			const batch = {
				version: 1 as const,
				batchId: "batch-001",
				keyId: "key-abc123",
				timestamp: "2025-06-01T15:00:00.000Z",
				events: [
					{
						timestamp: "2025-06-01T14:30:00.000Z",
						sessionId: "ses-1",
						provider: "claude",
						model: "claude-sonnet-4-20250514",
						inputTokens: 100,
						outputTokens: 50,
						cacheCreationInputTokens: 0,
						cacheReadInputTokens: 0,
					},
				],
				signature: "base64sighere==",
			};
			const result = v.safeParse(batchPayloadSchema, batch);
			expect(result.success).toBe(true);
		});

		it("rejects wrong version number", () => {
			const bad = {
				version: 2,
				batchId: "batch-001",
				keyId: "key-abc123",
				timestamp: "2025-06-01T15:00:00.000Z",
				events: [],
				signature: "sig",
			};
			const result = v.safeParse(batchPayloadSchema, bad);
			expect(result.success).toBe(false);
		});
	});

	describe("cursorStateSchema", () => {
		it("validates a cursor state with file entries", () => {
			const cursor = {
				version: 1 as const,
				files: {
					"/home/user/.claude/projects/proj/ses1.jsonl": {
						byteOffset: 4096,
						lineCount: 42,
						lastModified: "2025-06-01T10:00:00.000Z",
					},
				},
			};
			const result = v.safeParse(cursorStateSchema, cursor);
			expect(result.success).toBe(true);
		});

		it("rejects negative byteOffset", () => {
			const bad = {
				version: 1 as const,
				files: {
					"/some/file.jsonl": {
						byteOffset: -1,
						lineCount: 0,
						lastModified: "2025-06-01T10:00:00.000Z",
					},
				},
			};
			const result = v.safeParse(cursorStateSchema, bad);
			expect(result.success).toBe(false);
		});
	});

	describe("daemonConfigSchema", () => {
		it("validates a config with both fields", () => {
			const cfg = { apiUrl: "https://api.example.com", apiKey: "secret" };
			const result = v.safeParse(daemonConfigSchema, cfg);
			expect(result.success).toBe(true);
		});

		it("validates a config with only apiUrl", () => {
			const cfg = { apiUrl: "http://localhost:3000" };
			const result = v.safeParse(daemonConfigSchema, cfg);
			expect(result.success).toBe(true);
		});

		it("rejects a non-URL apiUrl", () => {
			const bad = { apiUrl: "not-a-url" };
			const result = v.safeParse(daemonConfigSchema, bad);
			expect(result.success).toBe(false);
		});
	});
}
