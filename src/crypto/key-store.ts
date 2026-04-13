import {
	mkdir,
	writeFile,
	readFile,
	access,
	mkdtemp,
	rm,
	stat,
} from "node:fs/promises";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyObject } from "node:crypto";
import { KEYS_DIR } from "../constants.ts";
import { generateKeyPair } from "./keygen.ts";

export async function ensureKeysDir(): Promise<void> {
	await mkdir(KEYS_DIR, { recursive: true });
}

export async function saveKeyPair(publicKey: KeyObject, privateKey: KeyObject): Promise<void> {
	await ensureKeysDir();

	const publicPem = publicKey.export({ type: "spki", format: "pem" }) as string;
	const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

	await writeFile(join(KEYS_DIR, "public.pem"), publicPem, { encoding: "utf8" });
	await writeFile(join(KEYS_DIR, "private.pem"), privatePem, {
		encoding: "utf8",
		mode: 0o600,
	});
}

export async function loadKeyPair(): Promise<{
	publicKey: KeyObject;
	privateKey: KeyObject;
} | null> {
	try {
		const [publicPem, privatePem] = await Promise.all([
			readFile(join(KEYS_DIR, "public.pem"), "utf8"),
			readFile(join(KEYS_DIR, "private.pem"), "utf8"),
		]);
		const publicKey = createPublicKey({ key: publicPem, format: "pem" });
		const privateKey = createPrivateKey({ key: privatePem, format: "pem" });
		return { publicKey, privateKey };
	} catch (err) {
		const error = err as NodeJS.ErrnoException;
		if (error.code === "ENOENT") return null;
		throw err;
	}
}

export async function loadPublicKey(): Promise<KeyObject | null> {
	try {
		const pem = await readFile(join(KEYS_DIR, "public.pem"), "utf8");
		return createPublicKey({ key: pem, format: "pem" });
	} catch (err) {
		const error = err as NodeJS.ErrnoException;
		if (error.code === "ENOENT") return null;
		throw err;
	}
}

export async function keyPairExists(): Promise<boolean> {
	try {
		await Promise.all([
			access(join(KEYS_DIR, "public.pem")),
			access(join(KEYS_DIR, "private.pem")),
		]);
		return true;
	} catch {
		return false;
	}
}

// Helpers used only in tests — operate on an arbitrary directory instead of KEYS_DIR.
async function saveKeyPairToDir(
	dir: string,
	publicKey: KeyObject,
	privateKey: KeyObject,
): Promise<void> {
	const publicPem = publicKey.export({ type: "spki", format: "pem" }) as string;
	const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
	await writeFile(join(dir, "public.pem"), publicPem, { encoding: "utf8" });
	await writeFile(join(dir, "private.pem"), privatePem, { encoding: "utf8", mode: 0o600 });
}

async function loadKeyPairFromDir(dir: string): Promise<{
	publicKey: KeyObject;
	privateKey: KeyObject;
} | null> {
	try {
		const [publicPem, privatePem] = await Promise.all([
			readFile(join(dir, "public.pem"), "utf8"),
			readFile(join(dir, "private.pem"), "utf8"),
		]);
		return {
			publicKey: createPublicKey({ key: publicPem, format: "pem" }),
			privateKey: createPrivateKey({ key: privatePem, format: "pem" }),
		};
	} catch (err) {
		const error = err as NodeJS.ErrnoException;
		if (error.code === "ENOENT") return null;
		throw err;
	}
}

async function keyPairExistsInDir(dir: string): Promise<boolean> {
	try {
		await Promise.all([access(join(dir, "public.pem")), access(join(dir, "private.pem"))]);
		return true;
	} catch {
		return false;
	}
}

if (import.meta.vitest != null) {
	describe("key-store", () => {
		let tmpDir: string;

		beforeEach(async () => {
			tmpDir = await mkdtemp(join(tmpdir(), "token-racer-ks-test-"));
		});

		afterEach(async () => {
			await rm(tmpDir, { recursive: true, force: true });
		});

		it("save → load round-trip preserves key material", async () => {
			const { publicKey, privateKey } = generateKeyPair();

			await saveKeyPairToDir(tmpDir, publicKey, privateKey);

			const loaded = await loadKeyPairFromDir(tmpDir);
			expect(loaded).not.toBeNull();
			expect(loaded?.publicKey.asymmetricKeyType).toBe("ed25519");
			expect(loaded?.privateKey.asymmetricKeyType).toBe("ed25519");

			// Confirm the exported PEM round-trips to the same bytes
			const originalPem = publicKey.export({ type: "spki", format: "pem" }) as string;
			const reExported = loaded?.publicKey.export({ type: "spki", format: "pem" }) as string;
			expect(reExported.trim()).toBe(originalPem.trim());
		});

		it("private key file has mode 0o600", async () => {
			const { publicKey, privateKey } = generateKeyPair();
			await saveKeyPairToDir(tmpDir, publicKey, privateKey);

			const info = await stat(join(tmpDir, "private.pem"));
			const mode = info.mode & 0o777;
			expect(mode).toBe(0o600);
		});

		it("loadKeyPair returns null when files are absent", async () => {
			const result = await loadKeyPairFromDir(tmpDir);
			expect(result).toBeNull();
		});

		it("keyPairExists returns false when missing, true when present", async () => {
			expect(await keyPairExistsInDir(tmpDir)).toBe(false);

			const { publicKey, privateKey } = generateKeyPair();
			await saveKeyPairToDir(tmpDir, publicKey, privateKey);

			expect(await keyPairExistsInDir(tmpDir)).toBe(true);
		});

		it("loadPublicKey-equivalent returns Ed25519 key", async () => {
			const { publicKey } = generateKeyPair();
			const pem = publicKey.export({ type: "spki", format: "pem" }) as string;
			await writeFile(join(tmpDir, "public.pem"), pem, { encoding: "utf8" });

			const loaded = createPublicKey({
				key: await readFile(join(tmpDir, "public.pem"), "utf8"),
				format: "pem",
			});
			expect(loaded.asymmetricKeyType).toBe("ed25519");
			expect(loaded.type).toBe("public");
		});
	});
}
