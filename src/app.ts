import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { MiddlewareHandler } from "hono";
import { config } from "./config.ts";
import health from "./routes/health.ts";
import prompt from "./routes/prompt.ts";
import sessions from "./routes/sessions.ts";

const app = new Hono();

app.use(logger());
app.use(
	cors({
		origin: config.corsOrigin === "*" ? "*" : config.corsOrigin,
		allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization"],
	}),
);

// --- Bearer auth minimal (aktif hanya jika API_TOKEN diisi) -----------------
const auth: MiddlewareHandler = async (c, next) => {
	if (!config.apiToken) return next();
	const header = c.req.header("Authorization") ?? "";
	if (header !== `Bearer ${config.apiToken}`) {
		return c.json({ error: "unauthorized" }, 401);
	}
	await next();
};

// --- Rate limit sederhana: 20 req/menit/IP (in-memory) -----------------------
const hits = new Map<string, { count: number; resetAt: number }>();

const rateLimit: MiddlewareHandler = async (c, next) => {
	const now = Date.now();
	const ip =
		c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
		"unknown";
	const entry = hits.get(ip);
	if (!entry || now >= entry.resetAt) {
		hits.set(ip, { count: 1, resetAt: now + config.rateLimitWindowMs });
		return next();
	}
	entry.count++;
	if (entry.count > config.rateLimitMax) {
		const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
		c.header("Retry-After", String(retryAfter));
		return c.json({ error: "rate limit terlampaui, coba lagi nanti" }, 429);
	}
	await next();
};

app.use("/api/*", auth, rateLimit);

// --- Routes ------------------------------------------------------------------
app.route("/health", health);
app.route("/api/prompt", prompt);
app.route("/api/sessions", sessions);

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
	console.error("[app]Unhandled:", err);
	return c.json({ error: "internal server error" }, 500);
});

export default app;
