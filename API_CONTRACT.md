# API_CONTRACT — fixit backend

Base URL: `http://localhost:3000` (`PORT` di env, default `3000`).
Semua path di bawah sesuai implementasi di `src/app.ts`, `src/routes/*`, `src/schemas.ts`.

## Konvensi global

- Content-Type request JSON: `application/json`.
- Auth: jika `API_TOKEN` diisi → semua `/api/*` wajib header `Authorization: Bearer <token>`. Jika kosong → tanpa auth (dev lokal). Lihat `src/app.ts#auth`.
- Rate limit: `20 req/menit/IP` default (`RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS`), key = `x-forwarded-for` atau `unknown`. Lebih → `429 + Retry-After`. Lihat `src/app.ts#rateLimit`.
- CORS: `CORS_ORIGIN` (default `http://localhost:5173`, `*` = semua, hanya dev).
- `404` untuk path tidak dikenal: `{ "error": "not found" }`.
- `500` fallback global: `{ "error": "internal server error" }`.

## 1. POST /api/prompt — SSE streaming (satu-satunya endpoint prompt)

`src/routes/prompt.ts` + `src/schemas.ts` + `src/agent/service.ts`.

### Request

```json
{
  "prompt": "buatkan file hello.txt di folder kerja ini",
  "sessionId": "27f495f3-b37e-44e3-80ac-2e68791238c2",
  "streamingBehavior": "steer"
}
```

| Field | Wajib | Aturan (zod) |
| ----- | ----- | ------------ |
| `prompt` | ya | `string, min 1, max MAX_PROMPT_CHARS` (default 8000). Lebih → `400`. |
| `sessionId` | tidak | `string uuid valid`. Kosong = **ephemeral/sekali-pakai** (in-memory, langsung dispose, folder dihapus, id di `done` throwaway). Isi = **persistent** (lihat Lifecycle). Format salah → `400`. |
| `streamingBehavior` | tidak | `"steer" \| "followUp"`. Wajib diisi jika session sedang streaming, kalau tidak → `409`. Lihat Concurrency. |

### Response sukses — SSE `text/event-stream`

Header sudah terkirim → semua error berikutnya jadi `event: error`, bukan status HTTP.

| Event SSE | `data` (JSON string) | Sumber SDK |
| --------- | -------------------- | ---------- |
| `delta` | `{ "delta": "potongan teks" }` | `message_update` + `text_delta` |
| `tool` | `{ "tool": "read", "status": "start" }` / `{ "tool": "...", "status": "done" \| "error" }` | `tool_execution_start` / `tool_execution_end` (`isError` → `error`) |
| `done` | `{ "sessionId": "...", "text": "hasil penuh (getLastAssistantText)", "aborted": false }` | `agent_settled` (bukan `agent_end`, karena retry/antrean bisa lanjut). Jika `steer`/`followUp` mengantre, stream menunggu settle lanjutan agar `text` tidak kosong. |
| `error` | `{ "message": "...", "code": "CONFLICT" \| "TIMEOUT" }` | concurrency race pasca-header / `session.abort()` timeout |

Urutan normal: `delta*` → `tool*` → `done` (sekali). `done`/`error` hanya dikirim sekali per stream.

### Error sebelum stream (JSON biasa, header belum dikirim)

| Status | Kapan | Body |
| ------ | ----- | ---- |
| `400` | validasi zod gagal | `{ "error": "...", ... }` (dari `zValidator`) |
| `401` | `API_TOKEN` diisi tapi header salah | `{ "error": "unauthorized" }` |
| `429` | rate limit | `{ "error": "rate limit terlampaui, coba lagi nanti" }` |
| `409` | `session.isStreaming === true` dan tanpa `streamingBehavior` | `{ "error": "session sedang streaming; kirim ulang dengan streamingBehavior 'steer' atau 'followUp'", "code": "CONFLICT" }` |
| `500` | `getOrCreate()` gagal | `{ "error": "gagal membuat agent session: ..." }` |

### Lifecycle & workspace

- `AGENT_CWD` default `./workspace/`, dibuat otomatis di `src/index.ts`. Tiap session kerja di `<AGENT_CWD>/<sessionId>/` (dibuat di `sessionDir()`, nama dicek `assertSafeSessionId` anti path-traversal).
- Tanpa `sessionId` → ephemeral: `SessionManager.inMemory(cwd)`, **tidak** masuk `Map`, `finally` → `dispose() + removeSessionDir()` → folder dihapus.
- Dengan `sessionId` baru → persistent file-backed, masuk `Map<string, { session, lastSeen, cwd }>`, folder **dipertahankan** setelah `done`.
- Dengan `sessionId` yang sudah ada di `Map` → pakai lagi, `lastSeen = now`.
- Idle > `SESSION_TTL_MS` (default 30 mnt) → `evictIdle()` tiap 5 mnt (`src/index.ts`) → `dispose()` + hapus dari `Map` + hapus folder `workspace/<id>/` (matikan via `CLEANUP_WORKSPACE_ON_EVICT=false`).
- Timeout satu prompt: `PROMPT_TIMEOUT_MS` (default 120000) → `session.abort()` → `event: error { code: "TIMEOUT" }`.
- Client disconnect (`request.signal` / `stream.onAbort`) → `unsubscribe() + session.abort()`, **tanpa** `dispose()` yang persistent.

### Concurrency

- Cek utama = `session.isStreaming` (sumber kebenaran SDK), bukan flag manual.
- Tanpa `streamingBehavior` saat sibuk → `409` pre-stream. Dengan `"steer" | "followUp"` → diteruskan ke `session.prompt(text, { streamingBehavior })` (mengantre, stream menunggu settle lanjutan).
- Race (2 request lolos cek bareng, SDK reject): pasca-header → `event: error { code: "CONFLICT" }`.
- Syarat client: satu `sessionId` = satu percakapan serial. Paralel ke `sessionId` sama butuh `steer`/`followUp`.

### Contoh

```bash
# ephemeral (folder dihapus setelah done)
curl -N -X POST localhost:3000/api/prompt -H 'content-type: application/json' \
  -d '{"prompt":"buatkan fungsi fizzbuzz di js"}'

# persistent
SID=$(bun -e 'console.log(crypto.randomUUID())')
curl -N -X POST localhost:3000/api/prompt -H 'content-type: application/json' \
  -d "{\"prompt\":\"buatkan file hello.txt di folder kerja ini\",\"sessionId\":\"$SID\"}"
# lanjutan
curl -N -X POST localhost:3000/api/prompt -H 'content-type: application/json' \
  -d "{\"prompt\":\"tambahin file kedua\",\"sessionId\":\"$SID\",\"streamingBehavior\":\"followUp\"}"
```

## 2. GET /api/sessions/:id/messages

`src/routes/sessions.ts` — riwayat mentah `session.messages`.

- Sukses `200`: `{ "sessionId": "<id>", "messages": [...] }` (apa adanya, tanpa pagination). Memanggilnya me-refresh `lastSeen` (anti-evict).
- `404`: `{ "error": "session tidak ditemukan" }` (tidak ada di `Map`; termasuk ephemeral yang sudah di-dispose dan session hasil restart server).

```bash
curl localhost:3000/api/sessions/$SID/messages
```

## 3. DELETE /api/sessions/:id

`src/routes/sessions.ts` — `dispose()` + hapus dari `Map` + hapus folder `workspace/<id>/`.

- Sukses `200`: `{ "ok": true, "sessionId": "<id>" }`.
- `404`: `{ "error": "session tidak ditemukan" }`.

```bash
curl -X DELETE localhost:3000/api/sessions/$SID
```

## 4. GET /health

`src/routes/health.ts` — tanpa auth/rate-limit (di luar `/api/*`).

- Sukses `200`: `{ "status": "ok" }`.

```bash
curl localhost:3000/health
```

## Referensi kode

- Route: `src/app.ts`, `src/routes/prompt.ts`, `src/routes/sessions.ts`, `src/routes/health.ts`
- Validasi: `src/schemas.ts` (`promptSchema`)
- Session: `src/agent/manager.ts` (`getOrCreate`, `get`, `touch`, `has`, `disposeSession`, `sessionCount`, `evictIdle`, `removeSessionDir`)
- Streaming: `src/agent/service.ts` (`streamPrompt`)
- Konfig: `src/config.ts` (`port`, `agentCwd`, `promptTimeoutMs`, `maxPromptChars`, `sessionTtlMs`, `corsOrigin`, `apiToken`, `excludeTools`, `model`, `provider`, `thinkingLevel`, `rateLimitMax`, `rateLimitWindowMs`, `cleanupWorkspaceOnEvict`)
