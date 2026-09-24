// FFT-3D multiplayer server — Fastify + SSE + WebSocket + SQLite
// Endpoints:
//   POST  /api/fft/rooms              → создать комнату
//   POST  /api/fft/rooms/:id/join     → присоединиться гостем
//   GET   /api/fft/rooms/:id          → получить состояние
//   POST  /api/fft/rooms/:id/action   → применить действие (идемпотентно)
//   GET   /api/fft/rooms/:id/events   → SSE поток
//   GET   /api/fft/rooms/:id/ws       → WebSocket (token query)
//   GET   /api/fft/health             → статус

import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';

import { GameState, createInitialState, DISCONNECT_TIMEOUT_MS } from './state';
import { applyAction, checkAndApplyTimerSweep, checkDisconnect } from './actions';

// ─── База данных ─────────────────────────────────────────────────────────────

const DB_PATH = path.join(__dirname, '..', 'fft.db');
const db = new Database(DB_PATH);

const schemaPath = fs.existsSync(path.join(__dirname, 'schema.sql'))
  ? path.join(__dirname, 'schema.sql')
  : path.join(__dirname, '..', 'schema.sql');
db.exec(fs.readFileSync(schemaPath, 'utf-8'));
db.pragma('journal_mode = WAL');

// ─── Кэш последних ответов для идемпотентности ───────────────────────────────

// roomId:token:actionId → serialized response
const actionCache = new Map<string, string>();

// ─── Rate limiting (in-memory) ────────────────────────────────────────────────

const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const times = (rateLimitMap.get(ip) ?? []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (times.length >= RATE_LIMIT_MAX) return false;
  times.push(now);
  rateLimitMap.set(ip, times);
  return true;
}

// ─── Вспомогательные функции БД ──────────────────────────────────────────────

interface RoomRow {
  state_json: string;
  host_token: string;
  guest_token: string | null;
  phase: string;
}

function getRoom(id: string): { state: GameState; hostToken: string; guestToken: string | null } | null {
  const row = db.prepare(
    'SELECT state_json, host_token, guest_token FROM rooms WHERE id = ?'
  ).get(id) as RoomRow | undefined;

  if (!row) return null;
  return {
    state: JSON.parse(row.state_json) as GameState,
    hostToken: row.host_token,
    guestToken: row.guest_token,
  };
}

function saveRoom(
  state: GameState,
  hostToken: string,
  guestToken: string | null,
): void {
  db.prepare(`
    INSERT INTO rooms (id, host_token, guest_token, state_json, created_at, updated_at, phase)
    VALUES (@id, @host_token, @guest_token, @state_json, @created_at, @updated_at, @phase)
    ON CONFLICT(id) DO UPDATE SET
      guest_token = excluded.guest_token,
      state_json  = excluded.state_json,
      updated_at  = excluded.updated_at,
      phase       = excluded.phase
  `).run({
    id: state.phase === 'lobby'
      ? (db.prepare('SELECT id FROM rooms WHERE id = ?').get(Object.keys({ _: state }).length.toString()) as { id: string } | undefined)?.id ?? uuidv4().slice(0, 8).toUpperCase()
      : undefined,
    host_token: hostToken,
    guest_token: guestToken,
    state_json: JSON.stringify(state),
    created_at: state.createdAt,
    updated_at: state.updatedAt,
    phase: state.phase,
  });
}

// Упрощённый вариант с явным roomId
function upsertRoom(
  roomId: string,
  state: GameState,
  hostToken: string,
  guestToken: string | null,
): void {
  db.prepare(`
    INSERT INTO rooms (id, host_token, guest_token, state_json, created_at, updated_at, phase)
    VALUES (@id, @host_token, @guest_token, @state_json, @created_at, @updated_at, @phase)
    ON CONFLICT(id) DO UPDATE SET
      guest_token = excluded.guest_token,
      state_json  = excluded.state_json,
      updated_at  = excluded.updated_at,
      phase       = excluded.phase
  `).run({
    id: roomId,
    host_token: hostToken,
    guest_token: guestToken,
    state_json: JSON.stringify(state),
    created_at: state.createdAt,
    updated_at: state.updatedAt,
    phase: state.phase,
  });
}

// ─── SSE подписчики ──────────────────────────────────────────────────────────

const subscribers = new Map<string, Set<(s: GameState) => void>>();
// X: chat subscribers — отдельный канал для chat-msg (не меняет GameState)
const chatSubscribers = new Map<string, Set<(msg: string) => void>>();

function subscribe(roomId: string, cb: (s: GameState) => void): () => void {
  if (!subscribers.has(roomId)) subscribers.set(roomId, new Set());
  subscribers.get(roomId)!.add(cb);
  return () => subscribers.get(roomId)?.delete(cb);
}

function subscribeChat(roomId: string, cb: (msg: string) => void): () => void {
  if (!chatSubscribers.has(roomId)) chatSubscribers.set(roomId, new Set());
  chatSubscribers.get(roomId)!.add(cb);
  return () => chatSubscribers.get(roomId)?.delete(cb);
}

function broadcast(roomId: string, state: GameState): void {
  subscribers.get(roomId)?.forEach(cb => cb(state));
}

function broadcastChat(roomId: string, msg: string): void {
  chatSubscribers.get(roomId)?.forEach(cb => cb(msg));
}

// ─── WS clients (для peerMove и учёта сокетов) ───────────────────────────────

type WsSocket = { readyState: number; send: (data: string) => void; on: (event: string, cb: (...args: unknown[]) => void) => void; close: () => void };
const wsRoomClients = new Map<string, Set<WsSocket>>();

function addWsClient(roomId: string, socket: WsSocket): () => void {
  if (!wsRoomClients.has(roomId)) wsRoomClients.set(roomId, new Set());
  wsRoomClients.get(roomId)!.add(socket);
  return () => wsRoomClients.get(roomId)?.delete(socket);
}

function broadcastWsExtra(roomId: string, payload: string, except?: WsSocket): void {
  wsRoomClients.get(roomId)?.forEach(s => {
    if (s !== except && s.readyState === 1) s.send(payload);
  });
}

// ─── Shared action helper (POST + WS) ────────────────────────────────────────

function handleRoomAction(
  roomId: string,
  token: string,
  body: { actionId?: string; type: string; [key: string]: unknown },
  opts?: { skipBroadcast?: boolean },
): { status: number; body: Record<string, unknown>; applied: boolean } {
  if (!token) {
    return { status: 401, body: { error: 'Требуется X-Session-Token' }, applied: false };
  }

  const room = getRoom(roomId);
  if (!room) {
    return { status: 404, body: { error: 'Комната не найдена' }, applied: false };
  }

  let actorTeam: 'A' | 'B';
  if (token === room.hostToken) actorTeam = 'A';
  else if (token === room.guestToken) actorTeam = 'B';
  else {
    return { status: 403, body: { error: 'Неверный токен' }, applied: false };
  }

  const { actionId, ...action } = body;
  if (actionId) {
    const cacheKey = `${roomId}:${token}:${actionId}`;
    if (actionCache.has(cacheKey)) {
      return {
        status: 200,
        body: JSON.parse(actionCache.get(cacheKey)!) as Record<string, unknown>,
        applied: false,
      };
    }
  }

  if (actorTeam === 'A') room.state.playerA.lastSeenAt = Date.now();
  else room.state.playerB.lastSeenAt = Date.now();

  const result = applyAction(room.state, actorTeam, action as Record<string, unknown>);

  if (!result.ok) {
    return { status: 400, body: result as unknown as Record<string, unknown>, applied: false };
  }

  upsertRoom(roomId, room.state, room.hostToken, room.guestToken);
  if (!opts?.skipBroadcast) {
    broadcast(roomId, room.state);
  }

  const responseBody: Record<string, unknown> = { ok: true, state: room.state, actorTeam };

  if (actionId) {
    const cacheKey = `${roomId}:${token}:${actionId}`;
    // Cache without actorTeam to keep HTTP response shape identical
    const cached = { ok: true, state: room.state };
    actionCache.set(cacheKey, JSON.stringify(cached));
    if (actionCache.size > 10_000) {
      const firstKey = actionCache.keys().next().value;
      if (firstKey) actionCache.delete(firstKey);
    }
  }

  return { status: 200, body: responseBody, applied: true };
}

// ─── Fastify сервер ──────────────────────────────────────────────────────────

const START_TS = Date.now();
const app = Fastify({ logger: true });

void (async () => {

await app.register(cors, {
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
});

await app.register(websocket);

// GET /api/fft/health
app.get('/api/fft/health', async () => ({
  ok: true,
  ts: Date.now(),
  uptime: Math.floor((Date.now() - START_TS) / 1000),
  version: '0.1.0',
}));

// POST /api/fft/rooms
app.post('/api/fft/rooms', async (req, reply) => {
  const ip = req.ip;
  if (!checkRateLimit(ip)) {
    return reply.code(429).send({ error: 'Too many requests. Лимит: 5 комнат в минуту.' });
  }

  const roomId = uuidv4().slice(0, 8).toUpperCase();
  const hostToken = uuidv4();
  const state = createInitialState();

  upsertRoom(roomId, state, hostToken, null);

  reply.code(201);
  return { roomId, hostToken };
});

// POST /api/fft/rooms/:id/join
app.post<{ Params: { id: string } }>('/api/fft/rooms/:id/join', async (req, reply) => {
  const roomId = req.params.id.toUpperCase();
  const room = getRoom(roomId);
  if (!room) return reply.code(404).send({ error: 'Комната не найдена' });

  // Reconnect host
  const existingToken = (req.headers['x-session-token'] ?? '') as string;
  if (existingToken === room.hostToken) {
    return { state: room.state };
  }
  // Reconnect guest
  if (room.guestToken && existingToken === room.guestToken) {
    return { state: room.state };
  }
  // Новый гость
  if (room.guestToken) {
    return reply.code(409).send({ error: 'Комната уже занята' });
  }
  if (room.state.phase === 'ended') {
    return reply.code(410).send({ error: 'Игра завершена' });
  }

  const guestToken = uuidv4();
  // Переходим в skill-selection когда оба игрока зашли
  room.state.phase = 'skill-selection';
  room.state.version++;
  room.state.updatedAt = Date.now();

  upsertRoom(roomId, room.state, room.hostToken, guestToken);
  broadcast(roomId, room.state);

  return { guestToken, state: room.state };
});

// GET /api/fft/rooms/:id
app.get<{ Params: { id: string } }>('/api/fft/rooms/:id', async (req, reply) => {
  const roomId = req.params.id.toUpperCase();
  const room = getRoom(roomId);
  if (!room) return reply.code(404).send({ error: 'Комната не найдена' });

  const token = (req.headers['x-session-token'] ?? '') as string;
  if (token !== room.hostToken && token !== room.guestToken) {
    return reply.code(401).send({ error: 'Требуется X-Session-Token' });
  }

  // Lazy timer check
  let changed = false;
  if (checkAndApplyTimerSweep(room.state)) changed = true;
  if (checkDisconnect(room.state, DISCONNECT_TIMEOUT_MS)) changed = true;
  if (changed) {
    upsertRoom(roomId, room.state, room.hostToken, room.guestToken);
    broadcast(roomId, room.state);
  }

  // Обновляем lastSeenAt
  const isHost = token === room.hostToken;
  if (isHost) room.state.playerA.lastSeenAt = Date.now();
  else room.state.playerB.lastSeenAt = Date.now();

  return room.state;
});

// POST /api/fft/rooms/:id/action
app.post<{
  Params: { id: string };
  Body: { actionId?: string; type: string; [key: string]: unknown };
}>('/api/fft/rooms/:id/action', async (req, reply) => {
  const roomId = req.params.id.toUpperCase();
  const token = (req.headers['x-session-token'] ?? '') as string;
  const result = handleRoomAction(roomId, token, req.body ?? { type: '' });
  // Strip internal actorTeam from HTTP response
  const { actorTeam: _at, ...httpBody } = result.body;
  if (result.status !== 200) {
    return reply.code(result.status).send(httpBody);
  }
  return httpBody;
});

// POST /api/fft/rooms/:id/chat — X: отправить chat-msg сопернику через SSE
app.post<{
  Params: { id: string };
  Body: { msg: string };
}>('/api/fft/rooms/:id/chat', async (req, reply) => {
  const roomId = req.params.id.toUpperCase();
  const token = (req.headers['x-session-token'] ?? '') as string;
  if (!token) return reply.code(401).send({ error: 'Требуется X-Session-Token' });

  const room = getRoom(roomId);
  if (!room) return reply.code(404).send({ error: 'Комната не найдена' });

  if (token !== room.hostToken && token !== room.guestToken) {
    return reply.code(403).send({ error: 'Неверный токен' });
  }

  const msg = String(req.body?.msg ?? '').slice(0, 100);
  if (!msg) return reply.code(400).send({ error: 'msg обязателен' });

  broadcastChat(roomId, msg);
  return { ok: true };
});

// GET /api/fft/rooms/:id/events — SSE
app.get<{ Params: { id: string }; Querystring: { token?: string } }>(
  '/api/fft/rooms/:id/events',
  async (req, reply) => {
    const roomId = req.params.id.toUpperCase();
    const room = getRoom(roomId);
    if (!room) return reply.code(404).send({ error: 'Комната не найдена' });

    const token = req.query.token ?? '';
    if (token !== room.hostToken && token !== room.guestToken) {
      return reply.code(401).send({ error: 'Требуется token' });
    }

    // SSE заголовки
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Первый снимок сразу
    reply.raw.write(`event: state\ndata: ${JSON.stringify({ type: 'state', state: room.state })}\n\n`);

    // Подписываемся на обновления GameState
    const unsub = subscribe(roomId, (state) => {
      reply.raw.write(`event: state\ndata: ${JSON.stringify({ type: 'state', state })}\n\n`);
    });

    // X: подписываемся на chat-msg
    const unsubChat = subscribeChat(roomId, (msg) => {
      reply.raw.write(`event: chat\ndata: ${JSON.stringify({ type: 'chat', msg })}\n\n`);
    });

    // Heartbeat каждые 25с
    const heartbeat = setInterval(() => {
      reply.raw.write(': ping\n\n');
    }, 25_000);

    req.socket.on('close', () => {
      unsub();
      unsubChat();
      clearInterval(heartbeat);
    });

    return reply;
  }
);

// GET /api/fft/rooms/:id/ws — WebSocket
app.get<{ Params: { id: string }; Querystring: { token?: string } }>(
  '/api/fft/rooms/:id/ws',
  { websocket: true },
  (socket, req) => {
    const roomId = req.params.id.toUpperCase();
    const token = req.query.token ?? '';
    const room = getRoom(roomId);

    if (!room || (token !== room.hostToken && token !== room.guestToken)) {
      socket.send(JSON.stringify({ type: 'error', error: !room ? 'Комната не найдена' : 'Требуется token' }));
      socket.close();
      return;
    }

    const removeClient = addWsClient(roomId, socket as unknown as WsSocket);

    // Snapshot
    socket.send(JSON.stringify({ type: 'state', state: room.state }));

    const unsub = subscribe(roomId, (state) => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'state', state }));
      }
    });

    const unsubChat = subscribeChat(roomId, (msg) => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'chat', msg }));
      }
    });

    const cleanup = () => {
      unsub();
      unsubChat();
      removeClient();
    };
    socket.on('close', cleanup);

    socket.on('message', (raw: unknown) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        socket.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
        return;
      }

      const type = msg.type as string;

      // ping → literal echo for wscat DoD
      if (type === 'ping') {
        socket.send(JSON.stringify({ type: 'ping' }));
        return;
      }

      // Alias map camelCase → kebab for applyAction
      const aliases: Record<string, string> = {
        endTurn: 'end-turn',
        skillSelect: 'set-skills',
      };
      if (aliases[type]) msg.type = aliases[type];

      // Normalize move fields: col/row → targetCol/targetRow if missing
      if (msg.type === 'move') {
        if (msg.targetCol == null && msg.col != null) msg.targetCol = msg.col;
        if (msg.targetRow == null && msg.row != null) msg.targetRow = msg.row;
      }

      const allowed = new Set([
        'move', 'attack', 'jump', 'push', 'skip-unit', 'end-turn', 'set-skills', 'ready', 'resign',
      ]);
      if (!allowed.has(msg.type as string)) {
        socket.send(JSON.stringify({ type: 'error', error: `Unknown type: ${msg.type}` }));
        return;
      }

      const result = handleRoomAction(
        roomId,
        token,
        msg as { actionId?: string; type: string; [key: string]: unknown },
        { skipBroadcast: true },
      );

      if (result.status >= 400 || !(result.body as { ok?: boolean }).ok) {
        socket.send(JSON.stringify({
          type: 'error',
          error: (result.body as { error?: string }).error ?? 'Action failed',
        }));
        return;
      }

      // Cache hit: no peerMove, no re-broadcast
      if (!result.applied) return;

      // peerMove before state so peers animate first
      if (msg.type === 'move' || type === 'move') {
        const peerPayload = JSON.stringify({
          type: 'peerMove',
          unitId: msg.unitId,
          targetCol: msg.targetCol,
          targetRow: msg.targetRow,
          team: result.body.actorTeam,
        });
        broadcastWsExtra(roomId, peerPayload, socket as unknown as WsSocket);
      }
      broadcast(roomId, result.body.state as GameState);
    });
  },
);

// ─── Server timer sweep (каждые 10с) ─────────────────────────────────────────

setInterval(() => {
  const rows = db.prepare(
    "SELECT id, state_json, host_token, guest_token FROM rooms WHERE phase = 'battle'"
  ).all() as Array<{ id: string; state_json: string; host_token: string; guest_token: string | null }>;

  for (const row of rows) {
    const state = JSON.parse(row.state_json) as GameState;
    let changed = false;

    if (checkAndApplyTimerSweep(state)) changed = true;
    if (checkDisconnect(state, DISCONNECT_TIMEOUT_MS)) changed = true;

    if (changed) {
      upsertRoom(row.id, state, row.host_token, row.guest_token);
      broadcast(row.id, state);
    }
  }
}, 10_000);

// ─── TTL cleanup (каждый час) ─────────────────────────────────────────────────

setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const deleted = db.prepare('DELETE FROM rooms WHERE updated_at < ?').run(cutoff);
  if (deleted.changes > 0) {
    app.log.info(`TTL cleanup: удалено ${deleted.changes} комнат`);
  }
}, 60 * 60 * 1000);

// ─── Запуск ──────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 8768);
const HOST = process.env.HOST ?? '0.0.0.0';

try {
  await app.listen({ port: PORT, host: HOST });
  console.log(`FFT-3D server running at http://${HOST}:${PORT}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}

})();
