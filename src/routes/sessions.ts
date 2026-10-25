import { Hono } from "hono";
import { disposeSession, get } from "../agent/manager.ts";

const sessions = new Hono();

/** GET /api/sessions/:id/messages — riwayat `session.messages` apa adanya. */
sessions.get("/:id/messages", (c) => {
	const session = get(c.req.param("id"));
	if (!session) {
		return c.json({ error: "session tidak ditemukan" }, 404);
	}
	return c.json({ sessionId: c.req.param("id"), messages: session.messages });
});

/** DELETE /api/sessions/:id — `dispose()` + hapus dari Map + hapus folder kerja. */
sessions.delete("/:id", (c) => {
	const id = c.req.param("id");
	if (!disposeSession(id)) {
		return c.json({ error: "session tidak ditemukan" }, 404);
	}
	return c.json({ ok: true, sessionId: id });
});

export default sessions;
