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

export const CorrectionSchema = z.object({
  corrected: z.string().trim().transform((s) => s.slice(0, 600)),
  /** Short Traditional Chinese explanation of the grammar / word-choice fixes; empty when unchanged. */
  note: z.string().trim().default("").transform((s) => s.slice(0, 300)),
});
export type Correction = z.infer<typeof CorrectionSchema>;

export const VocabItemSchema = z.object({
  word: z.string().trim().min(1).transform((s) => s.slice(0, 60)),
  zh: z.string().trim().default("").transform((s) => s.slice(0, 60)),
  example: z.string().trim().default("").transform((s) => s.slice(0, 300)),
});
export type VocabItem = z.infer<typeof VocabItemSchema>;

export const GrammarPointSchema = z.object({
  title: z.string().trim().min(1).transform((s) => s.slice(0, 80)),
  wrong: z.string().trim().default("").transform((s) => s.slice(0, 300)),
  fixed: z.string().trim().default("").transform((s) => s.slice(0, 300)),
});
export type GrammarPoint = z.infer<typeof GrammarPointSchema>;

export const FeedbackResultSchema = z.object({
  /** One entry per description, same order. */
  corrections: z.array(CorrectionSchema).min(1).max(10),
  /** Word-book material; optional so older replies still validate. */
  vocab: z.array(VocabItemSchema).default([]).transform((a) => a.slice(0, 3)),
  grammar: GrammarPointSchema.nullable().default(null),
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
