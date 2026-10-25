# PLAN: Backend Bun + Hono.js + Pi Agent

> Tujuan: backend HTTP yang menerima `input text (prompt)`, meneruskannya ke **Pi Agent** (`@earendil-works/pi-coding-agent` via `createAgentSession()`), dan mengembalikan hasil agent sebagai response **streaming SSE**.

Referensi SDK yang sudah terbukti jalan di repo ini: `minimal.ts` (`createAgentSession()` → `session.subscribe()` → `session.prompt()` → `session.getLastAssistantText()` → `session.dispose()`).

---

## 1. Arsitektur

```
Client (curl / FE)
   │  POST /api/prompt (SSE)
   ▼
Hono App (Bun.serve, port 3000)
   ├── validator (zod) : { prompt: 1..8000 char, sessionId?: uuid, streamingBehavior?: steer|followUp }
   ├── SessionStore : Map<sessionId, AgentSession>
   ├── AgentService : create / promptStream / dispose / abort
   └── serialize event Pi → SSE
         │
         ▼
Pi AgentSession (satu instance per sessionId)
   ├── session.subscribe(event => text_delta / tool / agent_settled)
   ├── session.prompt(text)
   └── session.dispose()
```

### Keputusan desain utama

1. **Satu `AgentSession` per `sessionId` (persistent, file-backed default), bukan satu global session.**
   Alasan: `session.prompt()` **reject jika session sedang streaming** (`session.isStreaming === true`) kecuali dipanggil dengan `streamingBehavior: "steer" / "followUp"`. Kalau satu session global dipakai rame-rame → request bersamaan selalu error. Solusi: `Map<sessionId, AgentSession>`, tiap client pegang `sessionId`-nya sendiri. Cek concurrency via `session.isStreaming` (sumber kebenaran SDK) — jangan bikin flag `busy` manual (racy).
2. **Opsi ephemeral (tanpa simpan file)** didukung via `SessionManager.inMemory(cwd)` yang di-pass eksplisit ke `createAgentSession({ sessionManager })` untuk request sekali-pakai (`POST /api/prompt` tanpa `sessionId` → buat session in-memory, stream, dispose langsung setelah `done`). Tanpa ini session "sekali-pakai" tetap ninggalin file di disk.
3. **Satu mode response: SSE streaming saja** (`text_delta` langsung di-flush ke client, hasil penuh di `event: done`). Tidak ada endpoint JSON non-streaming.
4. **Hono saja, tanpa framework tambahan.** Validasi pakai `hono/validator` + `zod`. CORS pakai `hono/cors`. Serve pakai `Bun.serve` bawaan Bun.

---

## 2. Struktur Proyek

```
fixit/
├── PLAN.md
├── package.json          # + hono, zod
├── tsconfig.json
├── minimal.ts            # contoh SDK existing (jangan dihapus, jadi referensi)
├── src/
│   ├── index.ts          # entry: Hono app + Bun.serve
│   ├── app.ts            # bikin Hono app, middleware (cors, logger, onError)
│   ├── config.ts         # env: PORT, PI_MODEL, PI_REASONING_LEVEL, AGENT_CWD, TIMEOUT
│   ├── agent/
│   │   ├── manager.ts    # SessionStore: getOrCreate, get, dispose, list
│   │   └── service.ts    # wrapper promptStream(), abort()
│   ├── routes/
│   │   ├── prompt.ts     # POST /api/prompt (SSE saja)
│   │   ├── sessions.ts   # GET /api/sessions/:id/messages, DELETE /api/sessions/:id
│   │   └── health.ts     # GET /health
│   └── schemas.ts        # zod schema: promptSchema
└── .env.example
```

---

## 3. Dependensi

```bash
bun add hono zod
bun add @earendil-works/pi-coding-agent  # sudah ada
# dev
bun add -d @types/bun
```

Bun versi repo: `1.3.14` — sudah kompatibel dengan Hono v4.

---

## 4. API Contract

### 4.1 `POST /api/prompt` — SSE streaming (satu-satunya endpoint prompt)

Request:

```json
{
  "prompt": "buatkan fungsi fizzbuzz di js",
  "sessionId": "opsional-uuid, kosong = sekali-pakai (in-memory, id di done jangan dipakai lagi)",
  "streamingBehavior": "opsional, steer | followUp — wajib jika session sedang streaming"
}
```

Response header `text/event-stream`. Event yang dikirim:

```
event: delta   → data: {"delta": "potongan teks"}
event: tool    → data: {"tool": "read", "status": "start|done"}
event: done    → data: {"sessionId": "...", "text": "hasil penuh (getLastAssistantText)"}
event: error   → data: {"message": "..."}
```

Mapping dari SDK:

- `message_update` + `text_delta` → `delta`
- `tool_*` events → `tool`
- `agent_settled` (bukan `agent_end`, karena retry/antrean masih bisa lanjut) → `done`

Error sebelum stream dimulai (header belum dikirim): `400` validasi gagal, `409` session sibuk, `404` session tidak ada.
Error setelah stream dimulai: dikirim sebagai `event: error` (termasuk timeout / agent error).

Catatan ephemeral (biar simpel): request tanpa `sessionId` itu sekali-pakai. `done.sessionId`-nya throwaway karena session langsung di-dispose — jangan dipakai lagi. Untuk chat lanjutan, client generate uuid sendiri dan kirim di tiap request.

### 4.2 Session endpoints

| Method   | Path                         | Fungsi                                                                               |
| -------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| `GET`    | `/api/sessions/:id/messages` | Kembalikan `session.messages` apa adanya ( simpel, tanpa pagination untuk sekarang ) |
| `DELETE` | `/api/sessions/:id`          | `session.dispose()` + hapus dari Map                                                 |
| `GET`    | `/health`                    | `{ status: "ok" }`                                                                   |

---

## 5. Alur Kerja (Sequence)

### Streaming SSE (satu-satunya alur prompt)

1. Hono terima `POST /api/prompt`, validasi zod.
2. `manager.getOrCreate(sessionId?, ephemeral?)`:
   - Jika `sessionId` ada di Map → pakai lagi (`touch()` + update `lastSeen`).
   - Jika tidak → `await createAgentSession()` dengan `SessionManager.inMemory(cwd)` bila ephemeral (tanpa `sessionId`), atau file-backed default bila persistent; simpan ke Map (kecuali ephemeral), generate uuid.
3. Cek `session.isStreaming`:
   - `true` dan tanpa `streamingBehavior` → return `409` JSON (sebelum header SSE dikirim).
   - `true` dan ada `streamingBehavior: "steer" | "followUp"` → teruskan sebagai `session.prompt(prompt, { streamingBehavior })`.
   - Tetap bungkus `session.prompt()` dengan `try/catch`: kalau SDK reject karena race (2 request lolos cek bareng), balas `409` / `event: error`. Jangan sampai jadi `500` mentah.
4. `session.subscribe(cb)` dipasang **sebelum** `prompt()` (wajib, sesuai docs SDK).
5. Tiap `text_delta` → `controller.enqueue("event: delta...")` + flush.
6. `await session.prompt(prompt, opts)` di background (teruskan `streamingBehavior` jika ada); saat `agent_settled` → kirim `event: done` (`sessionId` + `getLastAssistantText()`) + `close()`.
7. `unsubscribe()` di `finally`. Session **tidak** di-dispose (tetap hidup untuk kelanjutan chat), kecuali ephemeral → `dispose()` setelah `done`. Jika client disconnect (`request.signal.onabort`): `unsubscribe()` + `abort()` biar tidak nyangkut `isStreaming=true`, tapi jangan `dispose()` yang persistent.

Opsional (boleh skip dulu): `event: ping` tiap 15 detik kalau nanti stream sering kepotong proxy idle.

---

## 6. Contoh Implementasi Inti (acuan, bukan final)

`src/agent/manager.ts`:

```ts
import {
  createAgentSession,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";

type Entry = { session: AgentSession; lastSeen: number };
const store = new Map<string, Entry>();

export async function getOrCreate(
  sessionId: string | undefined,
  cwd: string,
  ephemeral: boolean,
) {
  const now = Date.now();
  if (sessionId && store.has(sessionId)) {
    const entry = store.get(sessionId)!;
    entry.lastSeen = now;
    return { sessionId, session: entry.session, created: false };
  }
  const sessionManager = ephemeral ? SessionManager.inMemory(cwd) : undefined; // undefined = file-backed default
  const { session } = await createAgentSession(
    sessionManager ? { sessionManager } : { cwd },
  );
  const id = sessionId ?? crypto.randomUUID();
  if (!ephemeral) store.set(id, { session, lastSeen: now });
  return { sessionId: id, session, created: true };
}

export function touch(sessionId: string) {
  store.get(sessionId)!.lastSeen = Date.now();
}

export function disposeSession(sessionId: string) {
  store.get(sessionId)?.session.dispose();
  store.delete(sessionId);
}

// Wajib: sweep session idle agar tidak OOM (dipanggil via setInterval di index.ts).
// Default: idle > 30 menit.
export function evictIdle(ttlMs = 30 * 60 * 1000) {
  const now = Date.now();
  for (const [id, entry] of store) {
    if (now - entry.lastSeen > ttlMs) disposeSession(id);
  }
}
```

`src/routes/prompt.ts` (sketsa):

```ts
import { Hono } from "hono";
import { zValidator } from "hono/validator";
import { z } from "zod";

const bodySchema = z.object({
  prompt: z.string().min(1).max(8000),
  sessionId: z.string().uuid().optional(),
  streamingBehavior: z.enum(["steer", "followUp"]).optional(),
});

// POST /api/prompt saja (SSE via streamSSE dari hono/helper/streaming)
// Tidak ada endpoint JSON non-streaming.
```

Entry `src/index.ts`:

```ts
import app from "./app";

const port = Number(process.env.PORT ?? 3000);
Bun.serve({ fetch: app.fetch, port });
console.log(`listening on :${port}`);

// Wajib: cegah Map session bocor (lihat manager.evictIdle).
setInterval(
  () => void import("./agent/manager").then((m) => m.evictIdle()),
  5 * 60 * 1000,
);
```

---

## 7. Konfigurasi & Env

`.env.example`:

```
PORT=3000
AGENT_CWD=/Users/uki/dev/fixit/workspace   # sandbox tool Pi, JANGAN root / (pastikan dir ada)
PI_MODEL=muse-spark-1.3-contributor
PI_REASONING_LEVEL=high   # nama env yang benar; opsi SDK-nya `thinkingLevel`
PROMPT_TIMEOUT_MS=120000
MAX_PROMPT_CHARS=8000
SESSION_TTL_MS=1800000   # 30 menit, untuk evictIdle
CORS_ORIGIN=http://localhost:5173
```

Catatan:

- `cwd` menentukan workspace tool Pi (read/write/edit) + grouping session file. **Wajib di-sandbox** — jangan arahkan ke `/` atau home tanpa batas.
- `PI_*` mengikuti kredensial yang sudah ada (provider `opencode-go`, lihat `env` saat ini). Jangan hardcode API key di repo.
- Opsional lanjutan: `model` / `thinkingLevel` override per-request, `excludeTools` (matikan tool berbahaya mis. `bash` untuk mode read-only), `customTools`, `settingsManager` in-memory.

---

## 8. Error Handling, Timeout, Abort

| Kasus                                 | Penanganan                                                                                                                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Body invalid                          | `400` dari `zValidator`                                                                                                                                                                   |
| Session sibuk (prompt saat streaming) | `409` pre-stream, kecuali client kirim `streamingBehavior: "steer" \| "followUp"` → teruskan ke `session.prompt(text, { streamingBehavior })`. Selalu `try/catch` `prompt()` untuk race.  |
| Agent macet/lama                      | `setTimeout(PROMPT_TIMEOUT_MS)` → `await session.abort()` → `event: error` (stream sudah jalan, jadi bukan `408` HTTP). `abort()` return `Promise<void>`, tidak ada `AbortSignal` di SDK. |
| Client disconnect (SSE)               | `request.signal.onabort` → `unsubscribe()` + `abort()`, JANGAN dispose session persistent                                                                                                 |
| Crash / restart server                | Session file-backed bisa dibuka lagi (`SessionManager` persistent); Map in-memory hilang → client buat session baru                                                                       |
| Tool error di dalam run               | SDK otomatis retry; jika gagal total → `event: error` (bukan `500` HTTP karena header SSE sudah terkirim)                                                                                 |

`onError` global di `app.ts` untuk fallback `500` JSON.

---

## 9. Keamanan (minimal wajib)

1. **Sandbox `cwd`** + pertimbangkan `excludeTools: ["bash"]` untuk endpoint publik.
2. **Batasi input**: max 8000 char, tolak prompt kosong.
3. **CORS ketat** (`CORS_ORIGIN`), bukan `*` saat production.
4. **Rate limit** sederhana (mis. 20 req/menit/IP) — Hono middleware atau reverse proxy.
5. **Jangan expose** `session.messages` mentah ke publik tanpa auth jika berisi data sensitif.
6. API key / secret hanya via env, jangan log prompt ke console di production.

---

## 10. Testing

```bash
bun install
bun run src/index.ts &
# health
curl localhost:3000/health
# streaming sekali-pakai (tanpa sessionId → in-memory, dispose otomatis)
curl -N -X POST localhost:3000/api/prompt \
  -H 'content-type: application/json' \
  -d '{"prompt":"buatkan fungsi fizzbuzz di js"}'
# streaming persistent (pakai uuid buatan client, dipakai ulang untuk lanjutan chat)
SID=$(bun -e 'console.log(crypto.randomUUID())')
curl -N -X POST localhost:3000/api/prompt \
  -H 'content-type: application/json' \
  -d "{\"prompt\":\"jelaskan repo ini\",\"sessionId\":\"$SID\"}"
curl -N -X POST localhost:3000/api/prompt \
  -H 'content-type: application/json' \
  -d "{\"prompt\":\"lanjutkan, tambah typescript types\",\"sessionId\":\"$SID\"}"
# riwayat + hapus
curl localhost:3000/api/sessions/$SID/messages
curl -X DELETE localhost:3000/api/sessions/$SID
# concurrency: 2 stream paralel ke sessionId sama → satu jalan, satu 409 JSON (belum masuk SSE)
SID2=$(bun -e 'console.log(crypto.randomUUID())')
(curl -sN -X POST localhost:3000/api/prompt -H 'content-type: application/json' -d "{\"prompt\":\"tugas lama, jawab panjang\",\"sessionId\":\"$SID2\"}" & curl -s -X POST localhost:3000/api/prompt -H 'content-type: application/json' -d "{\"prompt\":\"tugas kedua\",\"sessionId\":\"$SID2\"}")
# steer saat sibuk (tidak 409, masuk antrean steer)
curl -N -X POST localhost:3000/api/prompt -H 'content-type: application/json' -d "{\"prompt\":\"koreksi: abaikan, jawab singkat saja\",\"sessionId\":\"$SID2\",\"streamingBehavior\":\"steer\"}"
```

Kriteria sukses: `GET /health` `200`, SSE mengalir `delta` lalu `done` (`done` memuat `sessionId` + `text` penuh), request kedua dengan `sessionId` sama ingat konteks pertama, `DELETE` lalu `GET messages` → `404`.

---

## 11. Tahapan Pengerjaan

- [x] **Fase 1 — Scaffold**: `bun add hono zod`, bikin `src/{index,app,config,schemas}.ts`, `GET /health` jalan.
- [x] **Fase 2 — Streaming SSE**: `manager.ts` + `POST /api/prompt` pakai `streamSSE` (ephemeral in-memory dulu, lalu persistent via Map). Mapping `text_delta` → `delta`, tutup di `agent_settled` (`done` memuat `sessionId` + `text`). Test `curl -N`.
- [x] **Fase 3 — Session API + lifecycle (wajib, bukan opsional)**: `GET messages`, `DELETE`, cek `session.isStreaming` → `409` JSON pre-stream (atau teruskan `streamingBehavior`), timeout via `setTimeout` → `await session.abort()` → `event: error`, **TTL eviction wajib** (`touch()` tiap hit + `evictIdle()` via `setInterval` 5 menit, default idle > 30 menit).
- [x] **Fase 4 — Hardening**: CORS ketat, rate limit, sandbox `cwd` (pastikan dir ada), `excludeTools: ["bash"]` untuk endpoint publik, bearer auth minimal (wajib jika `GET /messages` exposed), `.env.example`, README cara jalanin.
- [ ] **Fase 5 (opsional)**: per-request `model`/`thinkingLevel` override, persist Map ke Redis/DB, Docker, metrik/logging.

---

## 12. Risiko & Catatan

- **Concurrency**: satu session tidak bisa 2 prompt paralel → wajib per-sessionId + cek `session.isStreaming` → `409` atau antrean via `streamingBehavior`.
- **Memory leak**: session yang tidak pernah `dispose()` menumpuk → **wajib** TTL eviction di Fase 3 (`touch()` + `evictIdle()`, default idle > 30 menit). Jangan tunggu production.
- **Biaya & latensi LLM**: prompt panjang + tool loop bisa lama → timeout + max chars wajib.
- **Bun + SDK**: `createAgentSession` stabil di Bun (contoh `minimal.ts` jalan), tapi pastikan `session.dispose()` selalu di `finally`.
