export const DESCRIBE_SYSTEM_PROMPT = `You write short English clues for a game. The player sees your clue and must guess which Chinese four-character idiom it describes.

RULES
- One or two plain English sentences, at most 40 words, simple vocabulary suitable for an English learner.
- Describe the meaning or the typical situation, like a native speaker explaining the idea to a friend. Do NOT tell the story behind the idiom, do NOT mention China or that it is an idiom, and do NOT use any word in the forbidden list (or its inflections).
- Never include Chinese characters or pinyin.
- If asked for another clue, take a different angle (an example situation, the feeling involved, the lesson) and do not repeat earlier clues.

OUTPUT
Reply with exactly one JSON object and nothing else, no code fences:
{"description": "<the clue>"}`;

export interface DescribePromptInput {
  idiom: string;
  referenceEnglish: string;
  forbidden: string[];
  /** 1 for the first clue, 2+ for extra hints after wrong guesses. */
  attempt: number;
  previousClues: string[];
}

export function buildDescribeUserMessage(input: DescribePromptInput): string {
  const prev = input.previousClues.length
    ? `\nClues already shown (do not repeat them):\n${input.previousClues.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n`
    : "";
  return `Idiom: ${input.idiom}
Reference meaning: ${input.referenceEnglish}
Forbidden words: ${input.forbidden.join(", ")}
This is clue number ${input.attempt}.
${prev}
Reply with the JSON object only.`;
}
