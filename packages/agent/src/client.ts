import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_MODEL = "claude-sonnet-5-5";
export const DEFAULT_BASE_URL = "https://api.anthropic.com";

/**
 * Build the Claude client from triage's own settings, not the SDK's ambient ones.
 * Hosted coding environments (e.g. Claude Code on the web) reserve ANTHROPIC_API_KEY
 * and set ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN for their own use; picking those
 * up would send the agent's traffic to the wrong endpoint or bill the wrong account.
 * So: TRIAGE_ANTHROPIC_API_KEY wins, ANTHROPIC_API_KEY is the local-.env fallback,
 * the base URL is explicit, and an ambient auth token is never sent.
 */
export function createClient(
  env: Record<string, string | undefined>,
): { client: Anthropic } | { error: string } {
  const apiKey = env.TRIAGE_ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;
  if (!apiKey)
    return {
      error:
        "No API key. Set TRIAGE_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY) in a git-ignored .env (see .env.example) or export it.",
    };
  return {
    client: new Anthropic({
      apiKey,
      authToken: null,
      baseURL: env.TRIAGE_ANTHROPIC_BASE_URL || DEFAULT_BASE_URL,
    }),
  };
}
