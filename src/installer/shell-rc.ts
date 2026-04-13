import { readFile, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export type SupportedShell = "zsh" | "bash" | "fish";

export const MARKER_BEGIN = "# >>> token-racer >>>";
export const MARKER_END = "# <<< token-racer <<<";

export type ShellInstallResult =
	| { kind: "installed"; rcPath: string; shell: SupportedShell }
	| { kind: "already-installed"; rcPath: string; shell: SupportedShell }
	| { kind: "unsupported-shell"; detected: string | null; hint: string }
	| { kind: "error"; message: string };

export type ShellUninstallResult =
	| { kind: "removed"; rcPath: string; shell: SupportedShell }
	| { kind: "not-installed"; reason: string }
	| { kind: "unsupported-shell"; detected: string | null; hint: string }
	| { kind: "error"; message: string };

/**
 * Writes a marker-delimited block to the user's shell rc file that wires up
 * `token-racer statusline` into the prompt via `token-racer shell-init`.
 *
 *   # >>> token-racer >>>
 *   eval "$(token-racer shell-init)"    # bash/zsh
 *   token-racer shell-init --shell=fish | source   # fish
 *   # <<< token-racer <<<
 *
 *   - If the block already exists (markers present) we leave it untouched.
 *   - If the shell can't be auto-detected, returns `unsupported-shell` — the
 *     caller should print manual instructions.
 *   - Atomic write with rename.
 */
export async function installShellRc(
	overrideShell?: SupportedShell,
): Promise<ShellInstallResult> {
	const shell = overrideShell ?? detectShell();
	if (shell === null) {
		return {
			kind: "unsupported-shell",
			detected: process.env["SHELL"] ?? null,
			hint: "Could not detect your shell. Supported: zsh, bash, fish. Re-run with --shell=<zsh|bash|fish> or add `eval \"$(token-racer shell-init)\"` to your rc file manually.",
		};
	}

	const rcPath = rcPathForShell(shell);
	const existing = await readFileIfExists(rcPath);
	if (existing === null) {
		// RC file doesn't exist — create it with just our block.
		try {
			await atomicWrite(rcPath, renderBlock(shell) + "\n");
			return { kind: "installed", rcPath, shell };
		} catch (err) {
			return { kind: "error", message: `Could not create ${rcPath}: ${errorMessage(err)}` };
		}
	}

	if (hasBlock(existing)) {
		return { kind: "already-installed", rcPath, shell };
	}

	const updated = appendBlock(existing, shell);
	try {
		await atomicWrite(rcPath, updated);
	} catch (err) {
		return { kind: "error", message: `Could not write ${rcPath}: ${errorMessage(err)}` };
	}
	return { kind: "installed", rcPath, shell };
}

/**
 * Removes the marker-delimited Token Racer block from the user's shell rc.
 */
export async function uninstallShellRc(
	overrideShell?: SupportedShell,
): Promise<ShellUninstallResult> {
	const shell = overrideShell ?? detectShell();
	if (shell === null) {
		return {
			kind: "unsupported-shell",
			detected: process.env["SHELL"] ?? null,
			hint: "Could not detect your shell. Remove the `# >>> token-racer >>>` block from your rc file manually.",
		};
	}

	const rcPath = rcPathForShell(shell);
	const existing = await readFileIfExists(rcPath);
	if (existing === null) {
		return { kind: "not-installed", reason: `${rcPath} does not exist` };
	}

	if (!hasBlock(existing)) {
		return { kind: "not-installed", reason: "Token Racer block not found" };
	}

	const updated = removeBlock(existing);
	try {
		await atomicWrite(rcPath, updated);
	} catch (err) {
		return { kind: "error", message: `Could not write ${rcPath}: ${errorMessage(err)}` };
	}
	return { kind: "removed", rcPath, shell };
}

// ---------------------------------------------------------------------------
// Shell detection + paths
// ---------------------------------------------------------------------------

export function detectShell(): SupportedShell | null {
	const shellEnv = process.env["SHELL"];
	if (typeof shellEnv !== "string" || shellEnv === "") return null;

	const name = path.basename(shellEnv).toLowerCase();
	if (name === "zsh") return "zsh";
	if (name === "bash") return "bash";
	if (name === "fish") return "fish";
	return null;
}

export function rcPathForShell(shell: SupportedShell): string {
	const home = os.homedir();
	switch (shell) {
		case "zsh":
			return path.join(home, ".zshrc");
		case "bash":
			return path.join(home, ".bashrc");
		case "fish":
			return path.join(home, ".config", "fish", "config.fish");
	}
}

// ---------------------------------------------------------------------------
// Block rendering + detection
// ---------------------------------------------------------------------------

export function renderBlock(shell: SupportedShell): string {
	// Guard the invocation so the block silently no-ops when `token-racer` is
	// not on PATH (e.g., user uninstalled the binary but left the rc block,
	// or installed to a non-PATH location). `doctor` will surface the gap.
	const body =
		shell === "fish"
			? "command -q token-racer; and token-racer shell-init --shell=fish | source"
			: 'command -v token-racer >/dev/null 2>&1 && eval "$(token-racer shell-init)"';

	return [
		MARKER_BEGIN,
		"# This block was added by `token-racer install`. Run `token-racer uninstall` to remove it.",
		body,
		MARKER_END,
	].join("\n");
}

export function hasBlock(content: string): boolean {
	return content.includes(MARKER_BEGIN) && content.includes(MARKER_END);
}

export function appendBlock(existing: string, shell: SupportedShell): string {
	const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
	return (
		existing +
		(needsLeadingNewline ? "\n" : "") +
		(existing.length > 0 ? "\n" : "") +
		renderBlock(shell) +
		"\n"
	);
}

export function removeBlock(existing: string): string {
	const lines = existing.split("\n");
	const out: string[] = [];
	let inside = false;
	for (const line of lines) {
		if (line.trimEnd() === MARKER_BEGIN) {
			inside = true;
			// Also strip a single blank line immediately preceding the marker
			// if present, so removal doesn't leave a stranded blank.
			if (out.length > 0 && out.at(-1) === "") out.pop();
			continue;
		}
		if (inside && line.trimEnd() === MARKER_END) {
			inside = false;
			continue;
		}
		if (!inside) out.push(line);
	}
	return out.join("\n");
}

// ---------------------------------------------------------------------------
// FS helpers
// ---------------------------------------------------------------------------

async function readFileIfExists(filePath: string): Promise<string | null> {
	try {
		await access(filePath);
	} catch {
		return null;
	}
	return readFile(filePath, "utf8");
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
	const { rename } = await import("node:fs/promises");
	const tmp = `${filePath}.tmp`;
	await writeFile(tmp, content, "utf8");
	await rename(tmp, filePath);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// In-source tests
// ---------------------------------------------------------------------------

if (import.meta.vitest != null) {
	describe("renderBlock", () => {
		it("produces the bash/zsh form with eval", () => {
			const zsh = renderBlock("zsh");
			expect(zsh).toContain('eval "$(token-racer shell-init)"');
			expect(zsh).toContain(MARKER_BEGIN);
			expect(zsh).toContain(MARKER_END);
		});

		it("produces the fish form with source piping", () => {
			const fish = renderBlock("fish");
			expect(fish).toContain("token-racer shell-init --shell=fish | source");
		});

		it("guards the bash/zsh body with `command -v` so missing binary is a no-op", () => {
			const zsh = renderBlock("zsh");
			const bash = renderBlock("bash");
			expect(zsh).toContain("command -v token-racer >/dev/null 2>&1 && ");
			expect(bash).toContain("command -v token-racer >/dev/null 2>&1 && ");
		});

		it("guards the fish body with `command -q` so missing binary is a no-op", () => {
			const fish = renderBlock("fish");
			expect(fish).toContain("command -q token-racer");
		});
	});

	describe("hasBlock", () => {
		it("detects a previously-installed block", () => {
			expect(hasBlock(`# something\n${renderBlock("zsh")}\n# other`)).toBe(true);
		});
		it("ignores partial markers", () => {
			expect(hasBlock("# >>> token-racer >>>\n# no closing marker")).toBe(false);
			expect(hasBlock("# some line\n# no opening marker\n# <<< token-racer <<<")).toBe(false);
		});
	});

	describe("appendBlock", () => {
		it("preserves existing content and appends our block", () => {
			const before = "alias ls=exa\n";
			const after = appendBlock(before, "zsh");
			expect(after.startsWith(before)).toBe(true);
			expect(after.endsWith("\n")).toBe(true);
			expect(hasBlock(after)).toBe(true);
		});
		it("handles empty existing content", () => {
			const after = appendBlock("", "zsh");
			expect(hasBlock(after)).toBe(true);
		});
		it("does not duplicate trailing newlines", () => {
			const before = "alias x=y\n";
			const after = appendBlock(before, "zsh");
			expect(after).not.toMatch(/\n{3,}/);
		});
	});

	describe("removeBlock", () => {
		it("removes a clean block", () => {
			const before = "alias x=y\n\n" + renderBlock("zsh") + "\n\nexport FOO=1\n";
			const after = removeBlock(before);
			expect(after).not.toContain(MARKER_BEGIN);
			expect(after).toContain("alias x=y");
			expect(after).toContain("export FOO=1");
		});
		it("is idempotent when the block isn't there", () => {
			const content = "alias x=y\nexport FOO=1\n";
			expect(removeBlock(content)).toBe(content);
		});
	});

	describe("detectShell", () => {
		const originalShell = process.env["SHELL"];

		afterEach(() => {
			if (originalShell === undefined) delete process.env["SHELL"];
			else process.env["SHELL"] = originalShell;
		});

		it("detects zsh", () => {
			process.env["SHELL"] = "/bin/zsh";
			expect(detectShell()).toBe("zsh");
		});
		it("detects bash", () => {
			process.env["SHELL"] = "/usr/bin/bash";
			expect(detectShell()).toBe("bash");
		});
		it("detects fish", () => {
			process.env["SHELL"] = "/opt/homebrew/bin/fish";
			expect(detectShell()).toBe("fish");
		});
		it("returns null for unknown shell", () => {
			process.env["SHELL"] = "/usr/bin/pwsh";
			expect(detectShell()).toBeNull();
		});
		it("returns null when SHELL is unset", () => {
			delete process.env["SHELL"];
			expect(detectShell()).toBeNull();
		});
	});
}
