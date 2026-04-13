import { sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { generateKeyPair } from "./keygen.ts";
import type { TokenEvent } from "../types.ts";

export function canonicalJson(obj: unknown): string {
	if (obj === null || obj === undefined) {
		return JSON.stringify(obj);
	}
	if (Array.isArray(obj)) {
		const items = obj.map((item) => canonicalJson(item)).join(",");
		return `[${items}]`;
	}
	if (typeof obj === "object") {
		const record = obj as Record<string, unknown>;
		const sortedKeys = Object.keys(record).sort();
		const pairs = sortedKeys.map((key) => {
			const serializedKey = JSON.stringify(key);
			const serializedValue = canonicalJson(record[key]);
			return `${serializedKey}:${serializedValue}`;
		});
		return `{${pairs.join(",")}}`;
	}
	return JSON.stringify(obj);
}

function buildMessage(events: TokenEvent[], batchId: string, timestamp: string): Buffer {
	const payload = canonicalJson(events) + "\n" + batchId + "\n" + timestamp;
	return Buffer.from(payload, "utf8");
}

export function signBatch(
	events: TokenEvent[],
	batchId: string,
	timestamp: string,
	privateKey: KeyObject,
): string {
	const message = buildMessage(events, batchId, timestamp);
	// Ed25519 requires null algorithm — the key type determines the signing scheme
	return sign(null, message, privateKey).toString("base64");
}

export function verifyBatch(
	events: TokenEvent[],
	batchId: string,
	timestamp: string,
	signature: string,
	publicKey: KeyObject,
): boolean {
	const message = buildMessage(events, batchId, timestamp);
	try {
		return verify(null, message, publicKey, Buffer.from(signature, "base64"));
	} catch {
		return false;
	}
}

if (import.meta.vitest != null) {
	const makeFakeEvents = (): TokenEvent[] => [
		{
			sessionId: "sess-1",
			timestamp: "2024-01-01T00:00:00.000Z",
			provider: "claude",
			model: "claude-opus-4-20250514",
			inputTokens: 100,
			outputTokens: 50,
			cacheCreationInputTokens: 0,
			cacheReadInputTokens: 0,
			costUsd: 0.001,
		},
		{
			sessionId: "sess-2",
			timestamp: "2024-01-01T00:01:00.000Z",
			provider: "claude",
			model: "claude-sonnet-4-20250514",
			inputTokens: 200,
			outputTokens: 80,
			cacheCreationInputTokens: 5,
			cacheReadInputTokens: 10,
			costUsd: 0.002,
		},
	];

	describe("canonicalJson", () => {
		it("sorts object keys deterministically", () => {
			const a = canonicalJson({ z: 1, a: 2, m: 3 });
			const b = canonicalJson({ m: 3, z: 1, a: 2 });
			expect(a).toBe(b);
			expect(a).toBe('{"a":2,"m":3,"z":1}');
		});

		it("sorts nested object keys", () => {
			const result = canonicalJson({ b: { d: 4, c: 3 }, a: 1 });
			expect(result).toBe('{"a":1,"b":{"c":3,"d":4}}');
		});

		it("preserves array order", () => {
			const result = canonicalJson([3, 1, 2]);
			expect(result).toBe("[3,1,2]");
		});

		it("handles arrays of objects", () => {
			const a = canonicalJson([{ z: 1, a: 2 }, { y: 3, b: 4 }]);
			const b = canonicalJson([{ a: 2, z: 1 }, { b: 4, y: 3 }]);
			expect(a).toBe(b);
		});

		it("handles null and primitives", () => {
			expect(canonicalJson(null)).toBe("null");
			expect(canonicalJson(42)).toBe("42");
			expect(canonicalJson("hello")).toBe('"hello"');
			expect(canonicalJson(true)).toBe("true");
		});

		it("is deterministic across calls", () => {
			const events = makeFakeEvents();
			expect(canonicalJson(events)).toBe(canonicalJson(events));
		});
	});

	describe("signBatch / verifyBatch", () => {
		it("sign/verify round-trip succeeds", () => {
			const { publicKey, privateKey } = generateKeyPair();
			const events = makeFakeEvents();
			const batchId = "batch-abc-123";
			const timestamp = "2024-01-01T00:00:00.000Z";

			const sig = signBatch(events, batchId, timestamp, privateKey);
			expect(typeof sig).toBe("string");
			expect(sig.length).toBeGreaterThan(0);

			const ok = verifyBatch(events, batchId, timestamp, sig, publicKey);
			expect(ok).toBe(true);
		});

		it("verification fails when events are tampered", () => {
			const { publicKey, privateKey } = generateKeyPair();
			const events = makeFakeEvents();
			const batchId = "batch-abc-123";
			const timestamp = "2024-01-01T00:00:00.000Z";

			const sig = signBatch(events, batchId, timestamp, privateKey);

			const tampered = makeFakeEvents();
			const [first] = tampered;
			if (first == null) throw new Error("makeFakeEvents returned empty array");
			first.inputTokens = 9999;

			const ok = verifyBatch(tampered, batchId, timestamp, sig, publicKey);
			expect(ok).toBe(false);
		});

		it("verification fails when batchId is tampered", () => {
			const { publicKey, privateKey } = generateKeyPair();
			const events = makeFakeEvents();
			const timestamp = "2024-01-01T00:00:00.000Z";

			const sig = signBatch(events, "batch-original", timestamp, privateKey);
			const ok = verifyBatch(events, "batch-tampered", timestamp, sig, publicKey);
			expect(ok).toBe(false);
		});

		it("verification fails when timestamp is tampered", () => {
			const { publicKey, privateKey } = generateKeyPair();
			const events = makeFakeEvents();
			const batchId = "batch-abc-123";

			const sig = signBatch(events, batchId, "2024-01-01T00:00:00.000Z", privateKey);
			const ok = verifyBatch(events, batchId, "2024-01-02T00:00:00.000Z", sig, publicKey);
			expect(ok).toBe(false);
		});

		it("verification fails with wrong public key", () => {
			const { privateKey } = generateKeyPair();
			const { publicKey: wrongPublicKey } = generateKeyPair();
			const events = makeFakeEvents();
			const batchId = "batch-abc-123";
			const timestamp = "2024-01-01T00:00:00.000Z";

			const sig = signBatch(events, batchId, timestamp, privateKey);
			const ok = verifyBatch(events, batchId, timestamp, sig, wrongPublicKey);
			expect(ok).toBe(false);
		});

		it("returns false for malformed base64 signature", () => {
			const { publicKey } = generateKeyPair();
			const events = makeFakeEvents();
			const ok = verifyBatch(events, "batch-id", "ts", "not-valid-base64!!!", publicKey);
			expect(ok).toBe(false);
		});
	});
}
