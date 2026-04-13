import { mkdir } from "node:fs/promises";
import {
	TOKEN_RACER_DIR,
	KEYS_DIR,
	CURSORS_FILE,
	CONFIG_FILE,
} from "../constants.ts";

export async function ensureTokenRacerDirs(): Promise<void> {
	await Promise.all([
		mkdir(TOKEN_RACER_DIR, { recursive: true }),
		mkdir(KEYS_DIR, { recursive: true }),
	]);
}

export function getConfigPath(): string {
	return CONFIG_FILE;
}

export function getCursorsPath(): string {
	return CURSORS_FILE;
}

export {
	TOKEN_RACER_DIR,
	KEYS_DIR,
	CURSORS_FILE,
	CONFIG_FILE,
};
