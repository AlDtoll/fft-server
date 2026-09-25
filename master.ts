// master.ts — Master intervention endpoints for FFT-server
// Регистрирует REST + WebSocket маршруты для мастер-наблюдения и управления
// Endpoints:
//   GET  /api/fft/master/rooms              → список активных комнат (auth)
//   GET  /api/fft/master/room/:id/state     → снимок состояния комнаты (auth)
//   POST /api/fft/master/room/:id/effect    → вставить эффект в очередь (auth)
//   GET  /api/fft/master/room/:id/ws        → WebSocket (?role=observer|player&clientId=)

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { v4 as uuidv4 } from 'uuid';

// ─── Типы ─────────────────────────────────────────────────────────────────────

interface MasterRoom {
  roomId: string;
  scenarioId: string;
  startTime: number;
  playerHint: string;        // короткое описание «Рыцарь vs Громила»
  wsClients: Set<WsMasterClient>;
  closeTimer: NodeJS.Timeout | null;  // 60s grace TTL
  state: unknown;            // последний game-state snapshot (для late-join observer)
  effectQueue: Array<{ id: string; effects: unknown[] }>;  // FIFO для мастера
}

interface WsMasterClient {
  ws: { readyState: number; send: (data: string) => void };
  role: 'player' | 'observer';
  clientId: string;
}

// ─── In-memory хранилище комнат ───────────────────────────────────────────────

export const masterRooms = new Map<string, MasterRoom>();

// ─── Broadcast helper ─────────────────────────────────────────────────────────

export function broadcastMaster(roomId: string, msg: unknown): void {
  const room = masterRooms.get(roomId);
  if (!room) return;
  const data = JSON.stringify(msg);
  for (const client of room.wsClients) {
    if (client.ws.readyState === 1) client.ws.send(data);
  }
}

// ─── Проверка мастер-секрета ──────────────────────────────────────────────────

function checkMasterAuth(req: FastifyRequest, reply: FastifyReply): boolean {
  const secret = process.env.MASTER_SECRET;
  if (!secret) {
    reply.code(503).send({ error: 'MASTER_SECRET не настроен на сервере' });
    return false;
  }
  const header = (req.headers['x-master-secret'] ?? '') as string;
  if (!header || header !== secret) {
    reply.code(401).send({ error: 'Неверный или отсутствующий X-Master-Secret' });
    return false;
  }
  return true;
}

// ─── Регистрация маршрутов ────────────────────────────────────────────────────

export async function registerMasterRoutes(app: FastifyInstance): Promise<void> {

  // GET /api/fft/master/rooms — список активных комнат
  app.get('/api/fft/master/rooms', async (req, reply) => {
    if (!checkMasterAuth(req, reply)) return;

    const rooms = [...masterRooms.values()]
      .filter(r => r.wsClients.size > 0)
      .map(r => ({
        roomId: r.roomId,
        scenarioId: r.scenarioId,
        startTime: r.startTime,
        playerHint: r.playerHint,
        observerCount: [...r.wsClients].filter(c => c.role === 'observer').length,
        clientCount: r.wsClients.size,
      }));

    return rooms;
  });

  // GET /api/fft/master/room/:id/state — снимок состояния
  app.get<{ Params: { id: string } }>('/api/fft/master/room/:id/state', async (req, reply) => {
    if (!checkMasterAuth(req, reply)) return;

    const room = masterRooms.get(req.params.id);
    if (!room) {
      return reply.code(404).send({ error: 'Комната не найдена' });
    }

    return {
      roomId: room.roomId,
      state: room.state,
      alive: room.wsClients.size > 0,
    };
  });

  // POST /api/fft/master/room/:id/effect — добавить эффект в очередь
  app.post<{
    Params: { id: string };
    Body: { effects: Array<{ type: string; [key: string]: unknown }> };
  }>('/api/fft/master/room/:id/effect', async (req, reply) => {
    if (!checkMasterAuth(req, reply)) return;

    const room = masterRooms.get(req.params.id);
    if (!room) {
      return reply.code(404).send({ error: 'Комната не найдена' });
    }

    const { effects } = req.body ?? {};

    // Валидация
    if (!Array.isArray(effects) || effects.length === 0) {
      return reply.code(400).send({ error: 'effects должен быть непустым массивом' });
    }
    for (const e of effects) {
      if (!e || typeof e !== 'object' || typeof e.type !== 'string') {
        return reply.code(400).send({ error: 'Каждый эффект должен содержать поле type (string)' });
      }
    }

    const queueId = uuidv4();
    const item = { id: queueId, effects };
    room.effectQueue.push(item);

    // Отправляем всем клиентам комнаты
    broadcastMaster(room.roomId, { kind: 'masterEffect', queueId, effects });

    return { ok: true, queueId };
  });

  // GET /api/fft/master/room/:id/ws — WebSocket
  app.get<{
    Params: { id: string };
    Querystring: { role?: string; clientId?: string };
  }>(
    '/api/fft/master/room/:id/ws',
    { websocket: true },
    (socket, req) => {
      const roomId = req.params.id;
      const roleRaw = (req.query.role ?? 'observer') as string;
      const role: 'player' | 'observer' = roleRaw === 'player' ? 'player' : 'observer';
      const clientId = (req.query.clientId ?? uuidv4()) as string;

      let room = masterRooms.get(roomId);

      if (role === 'observer') {
        // Observer требует существующей комнаты
        if (!room) {
          socket.send(JSON.stringify({ kind: 'error', error: 'Комната не найдена' }));
          socket.close();
          return;
        }
      } else {
        // Player — создаём комнату если нет
        if (!room) {
          room = {
            roomId,
            scenarioId: roomId,   // сценарий определяется клиентом через stateSnapshot
            startTime: Date.now(),
            playerHint: '',
            wsClients: new Set(),
            closeTimer: null,
            state: null,
            effectQueue: [],
          };
          masterRooms.set(roomId, room);
          app.log.info({ roomId }, 'master: новая комната создана');
        }

        // Отменяем pending close если игрок вернулся
        if (room.closeTimer) {
          clearTimeout(room.closeTimer);
          room.closeTimer = null;
          app.log.info({ roomId }, 'master: closeTimer отменён (игрок переподключился)');
        }
      }

      const client: WsMasterClient = { ws: socket as unknown as WsMasterClient['ws'], role, clientId };
      room.wsClients.add(client);

      // Отправить текущий снимок состояния (для late-join observer)
      if (room.state !== null) {
        socket.send(JSON.stringify({ kind: 'stateSnapshot', state: room.state }));
      }

      // Heartbeat каждые 15с
      const heartbeat = setInterval(() => {
        if ((socket as unknown as { readyState: number }).readyState === 1) {
          socket.send(JSON.stringify({ kind: 'ping' }));
        }
      }, 15_000);

      // Обработка входящих сообщений от клиента
      socket.on('message', (raw: unknown) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(raw)) as Record<string, unknown>;
        } catch {
          socket.send(JSON.stringify({ kind: 'error', error: 'Invalid JSON' }));
          return;
        }

        // Клиент сообщает снимок состояния
        if (msg.kind === 'stateSnapshot' && msg.state !== undefined) {
          if (room) {
            room.state = msg.state;
            // Обновляем playerHint если есть
            if (typeof msg.playerHint === 'string') {
              room.playerHint = msg.playerHint;
            }
            // Обновляем scenarioId если есть
            if (typeof msg.scenarioId === 'string') {
              room.scenarioId = msg.scenarioId;
            }
          }
          return;
        }

        // masterAction — действие от observer (v2)
        // Observer отправляет действие, сервер транслирует как masterEffect всем клиентам
        if (msg.kind === 'masterAction') {
          if (role !== 'observer') return;  // только observer может слать
          const ALLOWED_ACTIONS = new Set([
            'moveUnit', 'setHp', 'setMaxHp', 'applyStatus',
            'info', 'terrainSet', 'spawnUnit', 'removeUnit',
          ]);
          const action = msg.action as string;
          if (!action || !ALLOWED_ACTIONS.has(action)) return;
          // Маппинг: capitalize первой буквы → тип эффекта
          const effectType = action[0].toUpperCase() + action.slice(1);
          const effect: Record<string, unknown> = { ...msg, type: effectType };
          delete effect.kind;
          delete effect.action;
          const queueId = uuidv4();
          if (room) {
            room.effectQueue.push({ id: queueId, effects: [effect] });
            broadcastMaster(roomId, { kind: 'masterEffect', queueId, effects: [effect] });
            app.log.info({ roomId, action, effectType }, 'master: observer masterAction');
          }
          return;
        }

        // engineEvent от игрока (logAction / unitMoved / damageDealt / etc)
        // → relay всем остальным клиентам комнаты (observer'ам)
        if (msg.kind === 'engineEvent') {
          if (role !== 'player') return;  // только игрок эмитит engineEvents
          if (!room) return;
          broadcastMaster(roomId, msg);
          return;
        }

        // pong-ответ на heartbeat
        if (msg.kind === 'pong') return;
      });

      // Закрытие соединения
      socket.on('close', () => {
        clearInterval(heartbeat);
        if (!room) return;
        room.wsClients.delete(client);

        if (role === 'player') {
          // Запускаем 60s grace TTL
          room.closeTimer = setTimeout(() => {
            // Уведомляем оставшихся наблюдателей
            broadcastMaster(roomId, { kind: 'roomClosed' });
            masterRooms.delete(roomId);
            app.log.info({ roomId }, 'master: комната удалена по closeTimer');
          }, 60_000);
          app.log.info({ roomId }, 'master: игрок отключился, closeTimer запущен (60s)');
        }
        // Observer — просто удаляем из wsClients, никакого таймера
      });
    },
  );
}
