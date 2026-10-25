# fixit backend — Bun + Hono.js + Pi Agent

Backend HTTP yang menerima `input text (prompt)`, meneruskannya ke **Pi Agent**
(`@earendil-works/pi-coding-agent` via `createAgentSession()`), dan mengembalikan
hasil agent sebagai response **streaming SSE**. Implementasi dari [`PLAN.md`](./PLAN.md).

## Cara jalanin

```bash
bun install
cp .env.example .env   # sesuaikan seperlunya
bun run src/index.ts   # atau: bun run dev (watch mode)
```

Server listen di `:3000` (`PORT`). `AGENT_CWD` (default `./workspace/`) dibuat
otomatis sebagai root sandbox tool Pi — tiap session kerja di foldernya
sendiri (`./workspace/<sessionId>/`). Request sekali-pakai (tanpa `sessionId`)
foldernya dihapus otomatis setelah selesai; session persistent foldernya
 dipertahankan (jadi hasil kerja antar chat tidak hilang).

## API

| Method | Path | Keterangan |
| ------ | ---- | ---------- |
| `POST` | `/api/prompt` | SSE streaming (satu-satunya endpoint prompt) |
| `GET` | `/api/sessions/:id/messages` | Riwayat `session.messages` |
| `DELETE` | `/api/sessions/:id` | `dispose()` + hapus dari Map |
| `GET` | `/health` | `{ status: "ok" }` |

`POST /api/prompt` body: `{ prompt, sessionId?: uuid, streamingBehavior?: "steer" | "followUp" }`.
Tanpa `sessionId` = sekali-pakai (in-memory, langsung dispose — id di `done` jangan dipakai lagi).
Event SSE: `delta` → `tool` → `done { sessionId, text }` / `error`.

Error sebelum stream: `400` validasi, `409` session sibuk, `401` tanpa bearer (jika `API_TOKEN` diisi).
Error setelah stream jalan: `event: error`.

## Contoh

```bash
curl localhost:3000/health
curl -N -X POST localhost:3000/api/prompt -H 'content-type: application/json' \
  -d '{"prompt":"buatkan fungsi fizzbuzz di js"}'
SID=$(bun -e 'console.log(crypto.randomUUID())')
curl -N -X POST localhost:3000/api/prompt -H 'content-type: application/json' \
  -d "{\"prompt\":\"jelaskan repo ini\",\"sessionId\":\"$SID\"}"
curl localhost:3000/api/sessions/$SID/messages
curl -X DELETE localhost:3000/api/sessions/$SID
```

## Catatan

- `minimal.ts` = contoh SDK referensi (jangan dihapus).
- Validasi zod via `@hono/zod-validator` (Hono v4 memisah validator ke paket ini).
- Session idle > `SESSION_TTL_MS` (default 30 mnt) di-evict otomatis tiap 5 menit.
- Untuk publik: isi `API_TOKEN`, set `CORS_ORIGIN` ketat, biarkan `EXCLUDE_TOOLS=bash`.
