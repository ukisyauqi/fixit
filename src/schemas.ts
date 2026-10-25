import { z } from "zod";
import { config } from "./config.ts";

/**
 * POST /api/prompt — satu-satunya endpoint prompt (SSE streaming).
 * Tanpa `sessionId` = sekali-pakai (ephemeral, in-memory, langsung dispose).
 */
export const promptSchema = z.object({
	prompt: z
		.string()
		.min(1, "prompt tidak boleh kosong")
		.max(config.maxPromptChars, `prompt maksimal ${config.maxPromptChars} karakter`),
	sessionId: z.string().uuid("sessionId harus UUID valid").optional(),
	streamingBehavior: z.enum(["steer", "followUp"]).optional(),
});

export type PromptBody = z.infer<typeof promptSchema>;
