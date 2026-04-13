import * as readline from "node:readline/promises";
import process from "node:process";

/**
 * Prompts the user for input if stdin is a TTY. Returns `fallback` unchanged
 * in non-interactive environments (CI, piped input, background daemons).
 *
 *   @param message  Prompt text, e.g. "Nickname [racer-ab12]: "
 *   @param fallback Value to return if we can't prompt. Also the implicit
 *                   "accept suggestion" when the user just hits Enter.
 */
export async function promptWithDefault(message: string, fallback: string): Promise<string> {
	if (!isInteractive()) return fallback;

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: true,
	});

	// Propagate SIGINT (Ctrl+C) as a real exit so a user who thinks they're
	// cancelling actually cancels — instead of silently registering with the
	// auto-generated default nickname.
	const sigintHandler = (): void => {
		try {
			rl.close();
		} catch {
			// already closed
		}
		process.stderr.write("\nCancelled.\n");
		process.exit(130); // standard SIGINT exit code
	};
	process.once("SIGINT", sigintHandler);

	try {
		const answer = await rl.question(message);
		const trimmed = answer.trim();
		return trimmed === "" ? fallback : trimmed;
	} catch {
		// Ctrl+D / EOF — treat as "accept default" (user closed stdin cleanly).
		return fallback;
	} finally {
		process.removeListener("SIGINT", sigintHandler);
		rl.close();
	}
}

export function isInteractive(): boolean {
	return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

// ---------------------------------------------------------------------------
// In-source tests
// ---------------------------------------------------------------------------

if (import.meta.vitest != null) {
	describe("isInteractive", () => {
		it("returns a boolean", () => {
			expect(typeof isInteractive()).toBe("boolean");
		});
	});

	describe("promptWithDefault (non-interactive path)", () => {
		it("returns the fallback without prompting when stdin is not a TTY", async () => {
			// Force non-TTY by stubbing the TTY flag. Vitest typically runs with
			// stdin.isTTY = false, but we override to be explicit.
			const originalIn = process.stdin.isTTY;
			const originalOut = process.stdout.isTTY;
			Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
			Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
			try {
				const result = await promptWithDefault("Nickname: ", "racer-default");
				expect(result).toBe("racer-default");
			} finally {
				Object.defineProperty(process.stdin, "isTTY", {
					value: originalIn,
					configurable: true,
				});
				Object.defineProperty(process.stdout, "isTTY", {
					value: originalOut,
					configurable: true,
				});
			}
		});
	});
}
