import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { streamSSE } from "hono/streaming";
import { promptSchema } from "../schemas.ts";
import { config } from "../config.ts";
import { getOrCreate, removeSessionDir } from "../agent/manager.ts";
import { streamPrompt } from "../agent/service.ts";

const prompt = new Hono();

/**
 * POST /api/prompt — SSE streaming (satu-satunya endpoint prompt).
 *
 * Error SEBELUM header SSE dikirim → JSON biasa:
 * - 400 validasi gagal (dari zValidator)
 * - 409 session sibuk tanpa `streamingBehavior`
 * Error SETELAH stream jalan → `event: error`.
 */
prompt.post("/", zValidator("json", promptSchema), async (c) => {
	const { prompt: text, sessionId, streamingBehavior } = c.req.valid("json");

	let resolved: Awaited<ReturnType<typeof getOrCreate>>;
	try {
		resolved = await getOrCreate(sessionId);
	} catch (err) {
		return c.json(
			{ error: `gagal membuat agent session: ${(err as Error).message}` },
			500,
		);
	}

	// Cek concurrency via `session.isStreaming` (sumber kebenaran SDK).
	// Tanpa `streamingBehavior`, prompt saat streaming → SDK pasti reject.
	if (resolved.session.isStreaming && !streamingBehavior) {
		if (resolved.ephemeral) {
			try {
				resolved.session.dispose();
			} catch {
				// abaikan
			}
		}
		return c.json(
			{
				error:
					"session sedang streaming; kirim ulang dengan streamingBehavior 'steer' atau 'followUp'",
				code: "CONFLICT",
			},
			409,
		);
	}

	return streamSSE(c, async (stream) => {
		try {
			await streamPrompt({
				session: resolved.session,
				sessionId: resolved.sessionId,
				prompt: text,
				streamingBehavior,
				timeoutMs: config.promptTimeoutMs,
				stream,
				signal: c.req.raw.signal,
			});
		} catch (err) {
			// streamPrompt sudah kirim `event: error` sendiri untuk kasus
			// race; di sini cukup log. Jangan lempar (header terkirim).
			if ((err as Error & { code?: string }).code !== "CONFLICT") {
				console.error("[prompt] stream error:", (err as Error).message);
			}
		} finally {
			// Ephemeral = sekali-pakai → dispose setelah `done` + hapus
			// folder kerjanya (throwaway). Persistent tetap hidup untuk
			// chat lanjutan dan foldernya dipertahankan.
			if (resolved.ephemeral) {
				try {
					resolved.session.dispose();
				} catch {
					// abaikan
				}
				removeSessionDir(resolved.sessionId);
			}
		}
	});
});

export default prompt;
