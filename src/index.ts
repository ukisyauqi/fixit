import { mkdirSync } from "node:fs";
import app from "./app.ts";
import { config } from "./config.ts";
import { evictIdle, sessionCount } from "./agent/manager.ts";

// Sandbox workspace tool Pi — pastikan ada sebelum session pertama dibuat.
mkdirSync(config.agentCwd, { recursive: true });

Bun.serve({ fetch: app.fetch, port: config.port });
console.log(`fixit backend listening on :${config.port} (cwd=${config.agentCwd})`);

// WAJIB: cegah Map session bocor — dispose yang idle > SESSION_TTL_MS.
setInterval(() => {
	try {
		const evicted = evictIdle();
		if (evicted > 0) console.log(`[index] active sessions: ${sessionCount()}`);
	} catch (err) {
		console.error("[index] evictIdle gagal:", (err as Error).message);
	}
}, 5 * 60 * 1000);
