import { z } from "zod";

export const GuessResultSchema = z.object({
  guess: z.string().trim().min(1).max(40),
  // Long free-text fields are clipped rather than rejected: a verbose model must not fail the round.
  // reason may be empty when the reply was salvaged from a truncated JSON.
  reason: z.string().trim().default("").transform((s) => s.slice(0, 300)),
  /** True only when the newest description is a complete, error-free sentence. */
  perfect_sentence: z.boolean().default(false),
  grammar_note: z.string().trim().default("").transform((s) => s.slice(0, 200)),
});
export type GuessResult = z.infer<typeof GuessResultSchema>;

export const FeedbackResultSchema = z.object({
  /** One corrected version per description, same order. */
  corrections: z.array(z.string().trim().transform((s) => s.slice(0, 600))).min(1).max(10),
});
export type FeedbackResult = z.infer<typeof FeedbackResultSchema>;

export const DescribeResultSchema = z.object({
  description: z.string().trim().min(1).transform((s) => s.slice(0, 400)),
});
export type DescribeResult = z.infer<typeof DescribeResultSchema>;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}
