import type { BatchPayload, TokenEvent } from "../types.ts";

export type SendResult =
	| { ok: true; accepted: number }
	| { ok: false; retryable: boolean; statusCode?: number; error: string };

type SenderOptions = {
	apiUrl: string;
	apiKey?: string;
	timeoutMs?: number;
};

/**
 * Strips keys whose value is `undefined` from a shallow copy of an object.
 * Applied to each TokenEvent before signing so canonicalJson produces a
 * deterministic canonical form regardless of which optional fields were set.
 */
export function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
	return Object.fromEntries(
		Object.entries(obj).filter(([, value]) => value !== undefined),
	) as T;
}

export function normalizeEvent(event: TokenEvent): TokenEvent {
	return stripUndefined(event as unknown as Record<string, unknown>) as unknown as TokenEvent;
}

/**
 * Reads the response body (best-effort) and returns a user-facing hint
 * suitable for appending to the main error message. Always returns a
 * string — empty when nothing useful was in the body. Never throws.
 */
async function readBodyHint(response: Response): Promise<string> {
	try {
		const text = await response.text();
		if (text === "") return "";

		// Try to interpret as JSON first — the backend returns
		// `{error: "...", reason?: "...", issues?: {...}}` on failure.
		try {
			const json = JSON.parse(text) as {
				error?: unknown;
				reason?: unknown;
				issues?: unknown;
			};
			const parts: string[] = [];
			if (typeof json.error === "string" && json.error !== "") parts.push(json.error);
			if (typeof json.reason === "string" && json.reason !== "") parts.push(`(${json.reason})`);
			if (json.issues !== undefined && json.issues !== null) {
				parts.push(`validation: ${JSON.stringify(json.issues)}`);
			}
			if (parts.length > 0) return ` — ${parts.join(" ")}`;
		} catch {
			// Not JSON; fall through.
		}

		// Fall back to raw body, trimmed to something readable.
		const trimmed = text.trim().slice(0, 200);
		return trimmed === "" ? "" : ` — ${trimmed}`;
	} catch {
		return "";
	}
}

export class BatchSender {
	private readonly apiUrl: string;
	private readonly apiKey: string | undefined;
	private readonly timeoutMs: number;

	constructor(options: SenderOptions) {
		this.apiUrl = options.apiUrl.replace(/\/$/, "");
		this.apiKey = options.apiKey;
		this.timeoutMs = options.timeoutMs ?? 10_000;
	}

	async send(batch: BatchPayload): Promise<SendResult> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);

		try {
			const response = await fetch(`${this.apiUrl}/v1/ingest`, {
				method: "POST",
				signal: controller.signal,
				headers: {
					"Content-Type": "application/json",
					...(this.apiKey ? { "Authorization": `Bearer ${this.apiKey}` } : {}),
					"X-Signature-Ed25519": batch.signature,
					"X-Signature-Timestamp": batch.timestamp,
					"X-Key-Id": batch.keyId,
				},
				body: JSON.stringify(batch),
			});

			if (response.ok) {
				// Parse `accepted` count from the response body if present;
				// fall back to the event count so the caller always gets a number.
				let accepted = batch.events.length;
				try {
					const body = (await response.json()) as Record<string, unknown>;
					if (typeof body["accepted"] === "number") {
						accepted = body["accepted"];
					}
				} catch {
					// Response may have no body or non-JSON body — ignore
				}
				return { ok: true, accepted };
			}

			const statusCode = response.status;

			// Read the body for its hint BEFORE branching on status — the backend's
			// own error message usually explains *why* far better than the HTTP
			// code alone (which field failed validation, which rate limit hit, etc).
			const bodyHint = await readBodyHint(response);

			// 401/403 — authentication failures: never retry
			if (statusCode === 401 || statusCode === 403) {
				return {
					ok: false,
					retryable: false,
					statusCode,
					error: `Auth error: HTTP ${statusCode}${bodyHint}. If your key was rotated, re-run \`token-racer auth register\`.`,
				};
			}

			// 4xx — client errors: don't retry (bad request, not found, etc.)
			if (statusCode >= 400 && statusCode < 500) {
				return {
					ok: false,
					retryable: false,
					statusCode,
					error: `Client error: HTTP ${statusCode}${bodyHint}`,
				};
			}

			// 5xx — server errors: retryable
			return {
				ok: false,
				retryable: true,
				statusCode,
				error: `Server error: HTTP ${statusCode}${bodyHint}`,
			};
		} catch (err) {
			// AbortError means we hit the timeout — retryable
			if (err instanceof Error && err.name === "AbortError") {
				return {
					ok: false,
					retryable: true,
					error: `Request timed out after ${this.timeoutMs}ms`,
				};
			}

			// Network-level failure (DNS, connection refused, etc.) — retryable
			const message = err instanceof Error ? err.message : String(err);
			return { ok: false, retryable: true, error: `Network error: ${message}` };
		} finally {
			clearTimeout(timer);
		}
	}
}

if (import.meta.vitest != null) {
	describe("stripUndefined", () => {
		it("removes keys with undefined values", () => {
			const input = { a: 1, b: undefined, c: "hello", d: undefined };
			const result = stripUndefined(input);
			expect(result).toEqual({ a: 1, c: "hello" });
			expect("b" in result).toBe(false);
			expect("d" in result).toBe(false);
		});

		it("preserves null, 0, false, and empty string", () => {
			const input = { a: null, b: 0, c: false, d: "" };
			const result = stripUndefined(input as Record<string, unknown>);
			expect(result).toEqual({ a: null, b: 0, c: false, d: "" });
		});

		it("does not mutate the original object", () => {
			const input: Record<string, unknown> = { a: 1, b: undefined };
			stripUndefined(input);
			expect("b" in input).toBe(true);
		});
	});

	describe("BatchSender", () => {
		const makeBatch = (): BatchPayload => ({
			version: 1,
			batchId: crypto.randomUUID(),
			keyId: "deadbeef01234567",
			timestamp: new Date().toISOString(),
			events: [
				{
					timestamp: new Date().toISOString(),
					sessionId: "sess-1",
					provider: "claude",
					model: "claude-sonnet-4-20250514",
					inputTokens: 100,
					outputTokens: 50,
					cacheCreationInputTokens: 0,
					cacheReadInputTokens: 0,
				},
			],
			signature: "base64sighere==",
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("returns ok:true with accepted count on 200", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue({
					ok: true,
					status: 200,
					json: async () => ({ accepted: 1 }),
				}),
			);

			const sender = new BatchSender({ apiUrl: "http://localhost:3000" });
			const result = await sender.send(makeBatch());

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.accepted).toBe(1);
			}
		});

		it("falls back to event count when response body has no accepted field", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue({
					ok: true,
					status: 201,
					json: async () => ({}),
				}),
			);

			const sender = new BatchSender({ apiUrl: "http://localhost:3000" });
			const batch = makeBatch();
			const result = await sender.send(batch);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.accepted).toBe(batch.events.length);
			}
		});

		it("returns ok:false retryable:true on 500", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue({
					ok: false,
					status: 500,
				}),
			);

			const sender = new BatchSender({ apiUrl: "http://localhost:3000" });
			const result = await sender.send(makeBatch());

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.retryable).toBe(true);
				expect(result.statusCode).toBe(500);
			}
		});

		it("returns ok:false retryable:false on 400", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue({
					ok: false,
					status: 400,
				}),
			);

			const sender = new BatchSender({ apiUrl: "http://localhost:3000" });
			const result = await sender.send(makeBatch());

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.retryable).toBe(false);
				expect(result.statusCode).toBe(400);
			}
		});

		it("returns ok:false retryable:false on 401", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue({
					ok: false,
					status: 401,
				}),
			);

			const sender = new BatchSender({ apiUrl: "http://localhost:3000" });
			const result = await sender.send(makeBatch());

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.retryable).toBe(false);
				expect(result.statusCode).toBe(401);
			}
		});

		it("returns ok:false retryable:false on 403", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue({
					ok: false,
					status: 403,
				}),
			);

			const sender = new BatchSender({ apiUrl: "http://localhost:3000" });
			const result = await sender.send(makeBatch());

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.retryable).toBe(false);
				expect(result.statusCode).toBe(403);
			}
		});

		it("returns ok:false retryable:true on network error", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
			);

			const sender = new BatchSender({ apiUrl: "http://localhost:3000" });
			const result = await sender.send(makeBatch());

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.retryable).toBe(true);
				expect(result.error).toMatch(/network error/i);
			}
		});

		it("returns ok:false retryable:true on timeout", async () => {
			vi.useFakeTimers();

			vi.stubGlobal(
				"fetch",
				vi.fn().mockImplementation(
					(_url: string, opts: RequestInit) =>
						new Promise<never>((_resolve, reject) => {
							(opts.signal as AbortSignal).addEventListener("abort", () => {
								const err = new Error("This operation was aborted");
								err.name = "AbortError";
								reject(err);
							});
						}),
				),
			);

			const sender = new BatchSender({ apiUrl: "http://localhost:3000", timeoutMs: 100 });
			const resultPromise = sender.send(makeBatch());

			await vi.advanceTimersByTimeAsync(200);

			const result = await resultPromise;

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.retryable).toBe(true);
				expect(result.error).toMatch(/timed out/i);
			}

			vi.useRealTimers();
		});

		it("strips trailing slash from apiUrl", async () => {
			let capturedUrl = "";
			vi.stubGlobal(
				"fetch",
				vi.fn().mockImplementation((url: string) => {
					capturedUrl = url;
					return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
				}),
			);

			const sender = new BatchSender({ apiUrl: "http://localhost:3000/" });
			await sender.send(makeBatch());

			expect(capturedUrl).toBe("http://localhost:3000/v1/ingest");
		});

		it("sends correct headers", async () => {
			let capturedHeaders: HeadersInit | undefined;
			vi.stubGlobal(
				"fetch",
				vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
					capturedHeaders = opts.headers;
					return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
				}),
			);

			const batch = makeBatch();
			const sender = new BatchSender({ apiUrl: "http://localhost:3000" });
			await sender.send(batch);

			const headers = capturedHeaders as Record<string, string>;
			expect(headers["Content-Type"]).toBe("application/json");
			expect(headers["X-Signature-Ed25519"]).toBe(batch.signature);
			expect(headers["X-Signature-Timestamp"]).toBe(batch.timestamp);
			expect(headers["X-Key-Id"]).toBe(batch.keyId);
			expect(headers["Authorization"]).toBeUndefined();
		});

		it("includes Authorization header when apiKey is provided", async () => {
			let capturedHeaders: HeadersInit | undefined;
			vi.stubGlobal(
				"fetch",
				vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
					capturedHeaders = opts.headers;
					return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
				}),
			);

			const batch = makeBatch();
			const sender = new BatchSender({ apiUrl: "http://localhost:3000", apiKey: "tr_live_abc123" });
			await sender.send(batch);

			const headers = capturedHeaders as Record<string, string>;
			expect(headers["Authorization"]).toBe("Bearer tr_live_abc123");
		});
	});
}
