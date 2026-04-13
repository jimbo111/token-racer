import { generateKeyPairSync, createHash } from "node:crypto";
import type { KeyObject } from "node:crypto";

export function generateKeyPair(): { publicKey: KeyObject; privateKey: KeyObject } {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	return { publicKey, privateKey };
}

export function deriveKeyId(publicKey: KeyObject): string {
	const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
	const hash = createHash("sha256").update(der).digest("hex");
	return hash.slice(0, 16);
}

if (import.meta.vitest != null) {
	describe("keygen", () => {
		it("generates an Ed25519 keypair", () => {
			const { publicKey, privateKey } = generateKeyPair();
			expect(publicKey.type).toBe("public");
			expect(privateKey.type).toBe("private");
			expect(publicKey.asymmetricKeyType).toBe("ed25519");
			expect(privateKey.asymmetricKeyType).toBe("ed25519");
		});

		it("deriveKeyId returns 16 hex chars", () => {
			const { publicKey } = generateKeyPair();
			const keyId = deriveKeyId(publicKey);
			expect(keyId).toHaveLength(16);
			expect(keyId).toMatch(/^[0-9a-f]{16}$/);
		});

		it("different keypairs produce different keyIds", () => {
			const { publicKey: pk1 } = generateKeyPair();
			const { publicKey: pk2 } = generateKeyPair();
			expect(deriveKeyId(pk1)).not.toBe(deriveKeyId(pk2));
		});

		it("same public key always yields the same keyId", () => {
			const { publicKey } = generateKeyPair();
			expect(deriveKeyId(publicKey)).toBe(deriveKeyId(publicKey));
		});
	});
}
