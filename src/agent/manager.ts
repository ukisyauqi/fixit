/**
 * SessionStore: satu `AgentSession` persistent per `sessionId`.
 *
 * Kenapa per-sessionId (bukan satu global session)?
 * `session.prompt()` reject saat `session.isStreaming === true` kecuali
 * dipanggil dengan `streamingBehavior: "steer" | "followUp"`. Satu session
 * global dipakai rame-rame → request bersamaan selalu error.
 *
 * Ephemeral (request tanpa `sessionId`): session in-memory
 * (`SessionManager.inMemory(cwd)`) yang TIDAK disimpan ke Map dan wajib
 * di-dispose caller setelah stream selesai — tanpa ini session
 * "sekali-pakai" tetap ninggalin file di disk.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	createAgentSession,
	ModelRuntime,
	SessionManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { config } from "../config.ts";

type Entry = { session: AgentSession; lastSeen: number; cwd: string };

const store = new Map<string, Entry>();

const VALID_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

// --- Model / thinkingLevel override (opsional, dari env) -------------------
// Di-resolve sekali lalu di-cache — dipakai untuk semua session baru.

let runtimePromise: Promise<ModelRuntime> | undefined;
let overrideCache:
	| Promise<{ model?: Model<any>; thinkingLevel?: ThinkingLevel }>
	| undefined;

async function resolveModelOverride(): Promise<{
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
}> {
	return (overrideCache ??= resolveModelOverrideUncached());
}

async function resolveModelOverrideUncached(): Promise<{
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
}> {
	const out: { model?: Model<any>; thinkingLevel?: ThinkingLevel } = {};

	if (config.thinkingLevel) {
		if (
			(VALID_THINKING_LEVELS as readonly string[]).includes(config.thinkingLevel)
		) {
			out.thinkingLevel = config.thinkingLevel as ThinkingLevel;
		} else {
			console.warn(
				`[manager] PI_REASONING_LEVEL="${config.thinkingLevel}" tidak dikenal, pakai default settings.`,
			);
		}
	}

	if (config.model) {
		try {
			const runtime = (runtimePromise ??= ModelRuntime.create());
			const rt = await runtime;
			let provider = config.provider;
			let id = config.model;
			if (id.includes("/")) {
				const [p, ...rest] = id.split("/");
				provider = p;
				id = rest.join("/");
			}
			let model: Model<any> | undefined;
			if (provider) {
				model = rt.getModel(provider, id);
			} else {
				for (const p of rt.getProviders()) {
					const pid = (p as { id?: string }).id;
					if (!pid) continue;
					model = rt.getModel(pid, id);
					if (model) break;
				}
			}
			if (model) {
				out.model = model;
			} else {
				console.warn(
					`[manager] model "${config.model}" tidak ditemukan, pakai default settings.`,
				);
			}
		} catch (err) {
			console.warn(
				"[manager] gagal resolve model override, pakai default settings:",
				(err as Error).message,
			);
		}
	}

	return out;
}

export type GetOrCreateResult = {
	sessionId: string;
	session: AgentSession;
	created: boolean;
	ephemeral: boolean;
	/** Folder kerja khusus session ini: `<AGENT_CWD>/<sessionId>`. */
	cwd: string;
};

/** Hanya id aman yang boleh jadi nama folder (cegah path traversal). */
function assertSafeSessionId(sessionId: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) {
		throw new Error(`sessionId tidak valid untuk folder kerja: ${sessionId}`);
	}
}

/** Folder kerja khusus satu session. Dibuat jika belum ada. */
function sessionDir(sessionId: string): string {
	assertSafeSessionId(sessionId);
	const dir = join(config.agentCwd, sessionId);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Hapus folder kerja satu session (best-effort).
 * Dijaga: hanya hapus yang di DALAM `AGENT_CWD`, tidak pernah root-nya.
 */
export function removeSessionDir(sessionId: string): boolean {
	try {
		assertSafeSessionId(sessionId);
		const root = resolve(config.agentCwd);
		const dir = resolve(join(config.agentCwd, sessionId));
		if (dir === root || !dir.startsWith(root + "/")) return false;
		rmSync(dir, { recursive: true, force: true });
		return true;
	} catch (err) {
		console.warn(
			`[manager] hapus folder session ${sessionId} gagal:`,
			(err as Error).message,
		);
		return false;
	}
}

/**
 * Ambil session dari Map, atau buat baru via `createAgentSession()`.
 * - `sessionId` ada di Map → pakai lagi (refresh `lastSeen`).
 * - `sessionId` baru (uuid buatan client) → session file-backed persistent.
 * - tanpa `sessionId` → ephemeral in-memory, TIDAK masuk Map.
 */
export async function getOrCreate(
	sessionId: string | undefined,
): Promise<GetOrCreateResult> {
	const now = Date.now();
	const ephemeral = !sessionId;

	if (sessionId && store.has(sessionId)) {
		const entry = store.get(sessionId)!;
		entry.lastSeen = now;
		return { sessionId, session: entry.session, created: false, ephemeral: false, cwd: entry.cwd };
	}

	// Tiap session kerja di foldernya sendiri: `<AGENT_CWD>/<sessionId>`.
	const id = sessionId ?? crypto.randomUUID();
	const cwd = sessionDir(id);

	const override = await resolveModelOverride();
	const baseOptions = {
		cwd,
		excludeTools: config.excludeTools.length > 0 ? config.excludeTools : undefined,
		...(override.model ? { model: override.model } : {}),
		...(override.thinkingLevel ? { thinkingLevel: override.thinkingLevel } : {}),
	} as const;

	const { session } = await createAgentSession(
		ephemeral
			? { ...baseOptions, sessionManager: SessionManager.inMemory(cwd) }
			: { ...baseOptions },
	);

	if (!ephemeral) {
		store.set(id, { session, lastSeen: now, cwd });
	}
	return { sessionId: id, session, created: true, ephemeral, cwd };
}

/** Ambil session persistent; `undefined` jika tidak ada (→ caller balas 404). */
export function get(sessionId: string): AgentSession | undefined {
	const entry = store.get(sessionId);
	if (entry) entry.lastSeen = Date.now();
	return entry?.session;
}

/** Refresh `lastSeen` tanpa mengambil session (dipakai endpoint read-only). */
export function touch(sessionId: string): void {
	const entry = store.get(sessionId);
	if (entry) entry.lastSeen = Date.now();
}

export function has(sessionId: string): boolean {
	return store.has(sessionId);
}

/** `dispose()` + hapus dari Map. Hapus folder kerja kecuali `deleteDir: false`. Return `false` jika session tidak dikenal. */
export function disposeSession(
	sessionId: string,
	opts?: { deleteDir?: boolean },
): boolean {
	const entry = store.get(sessionId);
	if (!entry) return false;
	try {
		entry.session.dispose();
	} catch (err) {
		console.warn(`[manager] dispose ${sessionId} gagal:`, (err as Error).message);
	}
	store.delete(sessionId);
	if (opts?.deleteDir !== false) {
		removeSessionDir(sessionId);
	}
	return true;
}

export function sessionCount(): number {
	return store.size;
}

/**
 * WAJIB dipanggil berkala (lihat `setInterval` di `src/index.ts`):
 * dispose session yang idle > `ttlMs` agar Map tidak bocor (OOM).
 * Folder kerja ikut dihapus kecuali dimatikan via
 * `CLEANUP_WORKSPACE_ON_EVICT=false` atau `opts.deleteDir === false`.
 */
export function evictIdle(
	ttlMs: number = config.sessionTtlMs,
	opts?: { deleteDir?: boolean },
): number {
	const deleteDir = opts?.deleteDir ?? config.cleanupWorkspaceOnEvict;
	const now = Date.now();
	let evicted = 0;
	for (const [id, entry] of store) {
		if (now - entry.lastSeen > ttlMs) {
			disposeSession(id, { deleteDir });
			evicted++;
		}
	}
	if (evicted > 0) console.log(`[manager] evicted ${evicted} idle session(s)`);
	return evicted;
}
