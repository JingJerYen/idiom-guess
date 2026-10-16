import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

let client: Anthropic | null = null;

/** Lazily build the SDK client with the game-specific key (never ANTHROPIC_API_KEY). */
export function getClient(): Anthropic {
  if (!config.apiKey) {
    throw new Error("GAME_ANTHROPIC_KEY is not set; real model calls are unavailable");
  }
  if (!client) {
    client = new Anthropic({ apiKey: config.apiKey, maxRetries: 2, timeout: 30_000 });
  }
  return client;
}
