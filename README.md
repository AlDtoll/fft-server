# fft-server

Мультиплеерный бэкенд для FFT-3D. Fastify + SSE + SQLite.

## Клиент

URL: `https://loreworlds.ru:8443/fft-3d/`

Клиент лежит в `/var/www/loreworlds/fft-3d/index.html` — single-file HTML + Three.js (монолит, не под git).

## Стек

- TypeScript
- Fastify 4 + @fastify/cors
- better-sqlite3 (WAL mode)
- uuid
- Deploy: systemd unit `fft-server.service`, порт 8768

## Endpoints

- `POST /api/fft/rooms` — создать комнату
- `POST /api/fft/rooms/:id/join` — присоединиться гостем
- `GET  /api/fft/rooms/:id` — получить состояние
- `POST /api/fft/rooms/:id/action` — применить действие (идемпотентно по actionId)
- `GET  /api/fft/rooms/:id/events` — SSE поток
- `GET  /api/fft/health` — health

## Rate limit

5 запросов/мин на IP, in-memory Map.

## Файлы

- `server.ts` — HTTP-сервер, SSE, инициализация DB
- `state.ts` — типы и начальный state комнаты
- `actions.ts` — game loop, таймеры, обработка disconnect
- `map-gen.ts` — генератор карты
- `schema.sql` — DDL; копируется в `dist/schema.sql` при build
- `fft.db` — SQLite WAL (рантайм, не коммитить)

## Разработка

```
npm install
npm run dev     # ts-node server.ts
npm run build   # tsc && cp schema.sql dist/schema.sql
npm run start   # node dist/server.js
```

## Прод (systemd)

```
sudo systemctl restart fft-server
sudo systemctl status fft-server
journalctl -u fft-server -f
```

ENV: `PORT=8768`, `HOST=0.0.0.0`, `NODE_ENV=production`.
WorkingDirectory: `/home/claudeuser/sessions/games/workspace/fft-server`.

## Данные

SQLite файл `fft.db` в WorkingDirectory. WAL mode. Комнаты хранятся по id. Идемпотентность действий — через таблицу `action_cache` (ключ roomId:token:actionId).

## Локация клиента

`/var/www/loreworlds/fft-3d/index.html`, nginx + порт 8443.
Клиент обращается к серверу через `/api/fft/*` — nginx проксирует на `localhost:8768`.
Если меняется порт сервера — обновить конфиг nginx.
