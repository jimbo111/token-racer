import type { TokenEvent } from "../types.ts";

export interface Provider {
	/** Unique identifier for this provider (e.g., "claude", "codex", "opencode") */
	readonly name: string;

	/** Human-readable display name (e.g., "Claude Code", "OpenAI Codex") */
	readonly displayName: string;

	/** Check if this tool is installed on the system (directories exist) */
	detect(): Promise<boolean>;

	/** Get all directories where this tool writes logs */
	getLogDirs(): string[];

	/** File glob pattern within log dirs (e.g., "**\/*.jsonl") */
	getFilePattern(): string;

	/** Parse a single raw line/entry from a log file into TokenEvents.
	 * Returns empty array if the entry is not valid/parseable.
	 * For JSONL providers, rawContent is a single line.
	 * For JSON-per-file providers, rawContent is the entire file. */
	parseEntry(rawContent: string, context: ParseContext): TokenEvent[];
}

export interface ParseContext {
	/** Full path to the source file */
	filePath: string;
	/** Hashed project name (SHA-256, first 12 hex chars) */
	projectName: string;
	/** Fallback session ID derived from filename */
	fileSessionId: string;
}

/** File format that determines how the tailer reads */
export type FileFormat = "jsonl" | "json-per-file";

export interface ProviderConfig {
	provider: Provider;
	fileFormat: FileFormat;
}
