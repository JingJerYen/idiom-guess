import { z } from "zod";

export const GuessResultSchema = z.object({
  guess: z.string().trim().min(1).max(20),
  reason: z.string().trim().min(1).max(300),
  /** True only when the newest description is a complete, error-free sentence. */
  perfect_sentence: z.boolean().default(false),
  grammar_note: z.string().trim().max(200).default(""),
});
export type GuessResult = z.infer<typeof GuessResultSchema>;

export const FeedbackResultSchema = z.object({
  better_phrases: z.array(z.string().trim().min(1).max(300)).max(5),
  issues: z.array(z.string().trim().min(1).max(300)).max(5),
  tip: z.string().trim().min(1).max(400),
});
export type FeedbackResult = z.infer<typeof FeedbackResultSchema>;

export const DescribeResultSchema = z.object({
  description: z.string().trim().min(1).max(400),
});
export type DescribeResult = z.infer<typeof DescribeResultSchema>;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}
