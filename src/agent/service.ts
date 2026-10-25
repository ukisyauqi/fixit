/**
 * Orkestrasi satu streaming prompt: subscribe → prompt → SSE → settle.
 *
 * Aturan penting SDK:
 * - `session.subscribe(cb)` dipasang SEBELUM `session.prompt()`.
 * - `agent_settled` (bukan `agent_end`) = run benar-benar selesai —
 *   retry/antrean masih bisa lanjut setelah `agent_end`.
 * - Session TIDAK di-dispose di sini (tetap hidup untuk chat lanjutan),
 *   kecuali caller menandai ephemeral.
 */
import type { SSEStreamingApi } from "hono/streaming";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export type StreamingBehavior = "steer" | "followUp";

export type StreamPromptOptions = {
	session: AgentSession;
	sessionId: string;
	prompt: string;
	streamingBehavior?: StreamingBehavior;
	timeoutMs: number;
	stream: SSEStreamingApi;
	/** AbortSignal dari Hono request — untuk deteksi client disconnect. */
	signal?: AbortSignal;
};

const sse = (event: string, payload: unknown) =>
	JSON.stringify(payload);

/**
 * Tunggu `agent_settled` berikutnya. Resolve segera jika session sudah
 * idle (settle terlewat antara prompt-resolve dan subscribe).
 * `isCancelled` → batal menunggu (done/error sudah dikirim jalur lain).
 */
function waitForSettle(
	session: AgentSession,
	isCancelled: () => boolean,
): Promise<void> {
	if (!session.isStreaming || isCancelled()) return Promise.resolve();
	return new Promise<void>((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			unsub();
			resolve();
		};
		const unsub = session.subscribe((event) => {
			if (event.type === "agent_settled" || isCancelled()) finish();
		});
		// Settle yang terjadi sebelum subscribe terpasang → jangan gantung.
		if (!session.isStreaming) finish();
	});
}

function isConcurrencyError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /streaming|busy|steer|followUp|queue/i.test(msg);
}

/**
 * Jalankan prompt dan stream event Pi sebagai SSE.
 * Selalu `unsubscribe()` di `finally`. Melempar hanya untuk error yang
 * terjadi SEBELUM stream bermakna (biar route bisa kirim 409); error
 * setelah itu dikirim sebagai `event: error`.
 */
export async function streamPrompt(opts: StreamPromptOptions): Promise<void> {
	const { session, sessionId, prompt, streamingBehavior, timeoutMs, stream, signal } =
		opts;

	let done = false; // `done`/`error` sudah dikirim → jangan kirim lagi
	let timedOut = false;
	let clientGone = false;

	const writeDone = async (aborted: boolean) => {
		if (done || clientGone) return;
		done = true;
		await stream.writeSSE({
			event: "done",
			data: sse("done", {
				sessionId,
				text: session.getLastAssistantText() ?? "",
				aborted,
			}),
		});
	};

	const writeError = async (message: string, code?: string) => {
		if (done || clientGone) return;
		done = true;
		await stream.writeSSE({
			event: "error",
			data: sse("error", code ? { message, code } : { message }),
		});
	};

	// Timeout → abort run → `event: error` (bukan 408 HTTP karena
	// header SSE sudah terkirim).
	const timer = setTimeout(() => {
		timedOut = true;
		void (async () => {
			try {
				await session.abort();
			} catch {
				// abaikan — abort best-effort
			}
			await writeError(
				`prompt timed out after ${timeoutMs}ms (agent aborted)`,
				"TIMEOUT",
			);
		})();
	}, timeoutMs);

	const onAbort = () => {
		clientGone = true;
		clearTimeout(timer);
		unsubscribe();
		// Jangan nyangkut isStreaming=true, tapi JANGAN dispose yang persistent.
		void session.abort().catch(() => {});
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	stream.onAbort(onAbort);

	const unsubscribe = session.subscribe((event) => {
		if (clientGone) return;
		void (async () => {
			try {
				if (
					event.type === "message_update" &&
					event.assistantMessageEvent.type === "text_delta"
				) {
					await stream.writeSSE({
						event: "delta",
						data: sse("delta", { delta: event.assistantMessageEvent.delta }),
					});
				} else if (event.type === "tool_execution_start") {
					await stream.writeSSE({
						event: "tool",
						data: sse("tool", { tool: event.toolName, status: "start" }),
					});
				} else if (event.type === "tool_execution_end") {
					await stream.writeSSE({
						event: "tool",
						data: sse("tool", {
							tool: event.toolName,
							status: event.isError ? "error" : "done",
						}),
					});
				} else if (event.type === "agent_settled") {
					// Timeout sudah mengklaim `done` sebagai error → jangan timpa.
					if (timedOut) return;
					await writeDone(event.aborted);
				}
			} catch {
				// writeSSE gagal = client disconnect; onAbort yang urus sisanya.
			}
		})();
	});

	try {
		await session.prompt(
			prompt,
			streamingBehavior ? { streamingBehavior } : undefined,
		);
		// `steer`/`followUp` saat sibuk hanya MENGANTREKAN pesan — prompt()
		// bisa resolve sebelum antrean diproses. Tunggu run lanjutannya
		// settle agar stream ini mengembalikan jawaban yang benar,
		// bukan `done` kosong.
		if (streamingBehavior && !done && !clientGone && !timedOut) {
			await waitForSettle(session, () => clientGone || done || timedOut);
		}
	} catch (err) {
		// Race: 2 request lolos cek isStreaming bareng → SDK reject.
		// Header SSE sudah terkirim → balas `event: error`, bukan 409 HTTP.
		const message = err instanceof Error ? err.message : String(err);
		if (!done) {
			await writeError(
				message,
				isConcurrencyError(err) ? "CONFLICT" : undefined,
			);
		}
		// Beri tahu route bahwa ini konflik concurrency (untuk logging).
		if (isConcurrencyError(err)) {
			const e = new Error(message) as Error & { code?: string };
			e.code = "CONFLICT";
			throw e;
		}
		throw err;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		unsubscribe();
		// Jaminan: stream selalu ditutup `done` meski `agent_settled`
		// terlewat (mis. abort eksternal). Timeout sudah kirim error.
		if (!done && !clientGone && !timedOut) {
			await writeDone(false);
		}
	}
}
