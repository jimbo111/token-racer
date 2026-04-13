/**
 * Name of the upstream LLM tool that produced a token event.
 *
 * Attribution is stamped by the provider adapter (not inferred from model name)
 * because multiple tools can route through the same underlying model — e.g.
 * OpenCode can use Anthropic's claude-sonnet-4-5, which is indistinguishable
 * from a native Claude Code event if we only looked at `model`.
 */
export type ProviderName = "claude" | "codex" | "opencode";

export type TokenEvent = {
	timestamp: string;
	sessionId: string;
	/** LLM tool that produced this event (claude | codex | opencode). */
	provider: ProviderName;
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheCreationInputTokens: number;
	cacheReadInputTokens: number;
	speed?: "standard" | "fast";
	costUsd?: number;
	projectName?: string;
};

export type BatchPayload = {
	version: 1;
	batchId: string;
	keyId: string;
	timestamp: string;
	events: TokenEvent[];
	signature: string;
};

export type CursorState = {
	version: 1;
	files: Record<
		string,
		{
			byteOffset: number;
			lineCount: number;
			lastModified: string;
		}
	>;
};

export type DaemonConfig = {
	apiUrl: string;
	apiKey?: string;
	userId?: string;
	username?: string;
};
