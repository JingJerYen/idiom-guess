export const DESCRIBE_SYSTEM_PROMPT = `You write short English clues for a game played in Taiwan. The player sees your clue and must guess which Chinese term it describes. The term may be a classic idiom, an everyday expression, a shop or brand name, or a landmark.

RULES
- One or two plain English sentences, at most 40 words, simple vocabulary suitable for an English learner.
- Describe the meaning, the typical situation, or what the thing is and what it is known for, like a native speaker explaining it to a friend. Do NOT say the name, do NOT translate its characters, do NOT tell the origin story of an idiom, do NOT say what kind of term it is, and do NOT use any word in the forbidden list (or its inflections).
- Never include Chinese characters or pinyin.
- If asked for another clue, take a different angle (an example situation, the feeling involved, the lesson) and do not repeat earlier clues.

OUTPUT
Reply with exactly one JSON object and nothing else, no code fences:
{"description": "<the clue>"}`;

export interface DescribePromptInput {
  idiom: string;
  tags: string[];
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
  return `Term: ${input.idiom}
Kind: ${input.tags.join("、")}
Reference description: ${input.referenceEnglish}
Forbidden words: ${input.forbidden.join(", ")}
This is clue number ${input.attempt}.
${prev}
Reply with the JSON object only.`;
}
