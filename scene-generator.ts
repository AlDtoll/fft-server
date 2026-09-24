// F1: LLM scene generator via golem /chat (SSE)

export interface GenerateSceneInput {
  description: string;
  seed?: number;
}

export interface ScenarioUnit {
  id: string;
  class: string;
  team: string;
  col: number;
  row: number;
  level?: number;
  hp?: number;
  abilities?: string[];
}

export interface ScenarioCell {
  col: number;
  row: number;
  type: string;
  height?: number;
  upperLevel?: unknown;
  hasWall?: boolean;
  hasTower?: boolean;
  hasLadder?: boolean;
}

export interface ScenarioJson {
  id: string;
  name: string;
  description: string;
  terrain?: {
    cols: number;
    rows: number;
    cells: ScenarioCell[];
  };
  cells?: ScenarioCell[];
  units: ScenarioUnit[];
  weather?: null | { type: string; turnsLeft: number };
  winCondition: { type: string; targetTeam: string };
  [key: string]: unknown;
}

const KNOWN_CLASSES = new Set([
  'knight', 'ranger', 'mage', 'grunt', 'archer', 'brute', 'boss',
]);

const GOLEM_CHAT_URL = process.env.GOLEM_CHAT_URL ?? 'http://127.0.0.1:3100/chat';
const TIMEOUT_MS = Number(process.env.SCENE_GEN_TIMEOUT_MS ?? 120_000);

function buildPrompt(description: string, seed?: number): string {
  const seedHint =
    seed != null && Number.isFinite(seed)
      ? `\nSeed (для воспроизводимости имён/раскладки, если уместно): ${seed}\n`
      : '';

  return `Опиши сцену для fft-3d в JSON формате.

Схема:
{
  "id": string,
  "name": string,
  "description": string,
  "terrain": {
    "cols": 15,
    "rows": 15,
    "cells": [{col, row, type, height, upperLevel?, hasWall?, hasTower?, hasLadder?}]
  },
  "units": [{id, class: 'knight'|'ranger'|'mage'|'grunt'|'archer'|'brute'|'boss', team: 'player'|'enemy'|'ally'|'neutral', col, row, level: 0|1, hp, abilities: []}],
  "weather": null | {type: 'rain'|'fog'|'wind'|'sunny', turnsLeft: N},
  "winCondition": {type: 'eliminate', targetTeam: 'enemy'}
}

Описание: ${description}
${seedHint}
Выдай ТОЛЬКО валидный JSON.`;
}

function stripMarkdownFences(text: string): string {
  let s = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(s);
  if (fenced) return fenced[1].trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '');
    s = s.replace(/\s*```\s*$/, '');
  }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) return s.slice(start, end + 1);
  return s.trim();
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function normalizeScenario(raw: ScenarioJson): ScenarioJson {
  const cellsSrc = raw.terrain?.cells ?? raw.cells ?? [];
  const cells = cellsSrc.map((c) => ({
    ...c,
    col: clamp(Number(c.col), 0, 14),
    row: clamp(Number(c.row), 0, 14),
    type: typeof c.type === 'string' && c.type ? c.type : 'grass',
    height: c.height != null ? Number(c.height) : 0,
  }));

  const units = (raw.units ?? []).map((u, i) => {
    const cls = typeof u.class === 'string' ? u.class : 'grunt';
    return {
      ...u,
      id: u.id || `u${i + 1}`,
      class: KNOWN_CLASSES.has(cls) ? cls : 'grunt',
      team: u.team || 'enemy',
      col: clamp(Number(u.col), 0, 14),
      row: clamp(Number(u.row), 0, 14),
      level: u.level === 1 ? 1 : 0,
      hp: u.hp != null ? Number(u.hp) : 100,
      abilities: Array.isArray(u.abilities) ? u.abilities : [],
    };
  });

  return {
    ...raw,
    id: String(raw.id || 'generated'),
    name: String(raw.name || 'Generated Scenario'),
    description: String(raw.description || ''),
    terrain: { cols: 15, rows: 15, cells },
    units,
    weather: raw.weather ?? null,
    winCondition: raw.winCondition || { type: 'eliminate', targetTeam: 'enemy' },
  };
}

function validateScenario(s: ScenarioJson): void {
  if (!s.id || typeof s.id !== 'string') throw new Error('scenario.id missing');
  const cells = s.terrain?.cells ?? s.cells;
  if (!Array.isArray(cells)) throw new Error('scenario.terrain.cells or cells required');
  if (!Array.isArray(s.units) || s.units.length === 0) {
    throw new Error('scenario.units must be a non-empty array');
  }
  if (!s.winCondition || typeof s.winCondition !== 'object') {
    throw new Error('scenario.winCondition required');
  }
}

async function consumeGolemSse(res: Response): Promise<string> {
  if (!res.body) throw new Error('golem response has no body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let replyText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      const dataLines = part
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart());
      if (dataLines.length === 0) continue;
      const dataStr = dataLines.join('');
      let event: {
        type?: string;
        content?: string;
        message?: string;
        finalText?: string;
        partialText?: string;
        status?: string;
      };
      try {
        event = JSON.parse(dataStr);
      } catch {
        continue;
      }
      if (event.type === 'text' && typeof event.content === 'string') {
        replyText += event.content;
      } else if (event.type === 'completion') {
        if (!replyText && event.status === 'completed' && event.finalText) {
          replyText = event.finalText;
        }
        if (!replyText && event.partialText) {
          replyText = event.partialText;
        }
      } else if (event.type === 'error') {
        throw new Error(`golem error: ${event.message ?? 'unknown'}`);
      }
    }
  }

  return replyText;
}

export async function generateScene(input: GenerateSceneInput): Promise<ScenarioJson> {
  const description = String(input.description ?? '').trim();
  if (!description) throw new Error('description is required');

  const token = process.env.GOLEM_TOKEN;
  if (!token) throw new Error('GOLEM_TOKEN is not set');

  const prompt = buildPrompt(description, input.seed);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(GOLEM_CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        message: prompt,
        sessionKey: 'fft-scene-gen',
      }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if ((e as Error).name === 'AbortError') {
      throw new Error(`golem chat timed out after ${TIMEOUT_MS}ms`);
    }
    throw new Error(`golem chat request failed: ${(e as Error).message}`);
  }
  clearTimeout(timer);

  if (res.status === 401) throw new Error('golem chat unauthorized (check GOLEM_TOKEN)');
  if (!res.ok) {
    const snippet = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`golem chat HTTP ${res.status}: ${snippet}`);
  }

  const replyText = await consumeGolemSse(res);
  if (!replyText.trim()) throw new Error('golem returned empty response');

  let parsed: ScenarioJson;
  try {
    parsed = JSON.parse(stripMarkdownFences(replyText)) as ScenarioJson;
  } catch (e) {
    throw new Error(`invalid JSON from LLM: ${(e as Error).message}`);
  }

  const normalized = normalizeScenario(parsed);
  validateScenario(normalized);
  return normalized;
}
