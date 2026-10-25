/**
 * Konfigurasi backend — semua via environment variable.
 * Lihat `.env.example` untuk daftar lengkap.
 */

const num = (v: string | undefined, fallback: number): number => {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};

const bool = (v: string | undefined, fallback: boolean): boolean => {
	if (v === undefined || v.trim() === "") return fallback;
	return !/^(0|false|no|off)$/i.test(v.trim());
};

export const config = {
	/** Port HTTP (Bun.serve). */
	port: num(process.env.PORT, 3000),

	/**
	 * Root sandbox workspace untuk tool Pi (read/write/edit/bash).
	 * Tiap session kerja di foldernya sendiri: `<AGENT_CWD>/<sessionId>/`.
	 * WAJIB direktori khusus — jangan arahkan ke `/` atau home.
	 * Dibuat otomatis jika belum ada (lihat `src/index.ts`).
	 */
	agentCwd: process.env.AGENT_CWD ?? `${process.cwd()}/workspace`,

	/** Timeout satu prompt (ms) → `session.abort()` + `event: error`. */
	promptTimeoutMs: num(process.env.PROMPT_TIMEOUT_MS, 120_000),

	/** Batas panjang prompt (char) — dipakai zod schema. */
	maxPromptChars: num(process.env.MAX_PROMPT_CHARS, 8000),

	/** TTL idle session (ms) untuk `evictIdle()`. Default 30 menit. */
	sessionTtlMs: num(process.env.SESSION_TTL_MS, 30 * 60 * 1000),

	/** Origin CORS yang diizinkan (`*` = semua, hanya untuk dev). */
	corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",

	/**
	 * Bearer token untuk `/api/*`. Kosong = tanpa auth (dev lokal).
	 * WAJIB diisi jika endpoint di-expose ke publik.
	 */
	apiToken: process.env.API_TOKEN ?? "",

	/**
	 * Tool yang dimatikan untuk endpoint publik, koma-separated.
	 * Default `bash` (read-only-ish). Kosongkan untuk akses penuh.
	 */
	excludeTools: (process.env.EXCLUDE_TOOLS ?? "bash")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean),

	/** Override model opsional, mis. `opencode-go/muse-spark-1.3-contributor` atau bare id. */
	model: process.env.PI_MODEL || undefined,
	/** Provider untuk bare model id (fallback jika PI_MODEL tanpa prefix provider). */
	provider: process.env.PI_PROVIDER || undefined,
	/** Override thinking level opsional: off|minimal|low|medium|high|xhigh|max. */
	thinkingLevel: process.env.PI_REASONING_LEVEL || undefined,

	/** Rate limit sederhana: max request per window per IP (endpoint `/api/*`). */
	rateLimitMax: num(process.env.RATE_LIMIT_MAX, 20),
	rateLimitWindowMs: num(process.env.RATE_LIMIT_WINDOW_MS, 60_000),

	/**
	 * Hapus folder `workspace/<id>/` saat `evictIdle()` membuang session idle.
	 * Default `true` (cegah disk leak). Set `false` untuk mempertahankan file.
	 * `DELETE /api/sessions/:id` selalu hapus folder.
	 */
	cleanupWorkspaceOnEvict: bool(
		process.env.CLEANUP_WORKSPACE_ON_EVICT,
		true,
	),
} as const;

export type AppConfig = typeof config;
