// FFT-3D — типы состояния, константы, дефолты

// ─── Типы ────────────────────────────────────────────────────────────────────

export type Phase = 'lobby' | 'skill-selection' | 'battle' | 'ended';
export type Team = 'A' | 'B';
export type UnitClass = 'knight' | 'ranger' | 'mage';

export interface StatusEffects {
  stun?: boolean;
  immobilize?: boolean;
  slow?: boolean;
  barrier?: number;
}

export interface Unit {
  id: string;
  team: Team;
  class: UnitClass;
  col: number;
  row: number;
  hp: number;
  maxHp: number;
  atk: number;
  def: number;
  evasion: number;
  armor: number;
  moveRange: number;
  atkRange: number;
  visionRange: number;
  isRanged: boolean;
  alive: boolean;
  moved: boolean;
  acted: boolean;
  abilities: string[];
  cooldowns: Record<string, number>;
  statusEffects: StatusEffects;
}

export interface GridCell {
  type: string;
  height: number;
}

export interface PlayerMeta {
  ready: boolean;
  lastSeenAt: number;
}

export interface LogEntry {
  text: string;
  team?: Team;
  type: string;
}

export interface GameState {
  version: number;
  phase: Phase;
  currentTeam: Team;
  turnNumber: number;
  turnDeadline: number | null;
  units: Unit[];
  grid: GridCell[][];
  playerA: PlayerMeta;
  playerB: PlayerMeta;
  winner: Team | null;
  log: LogEntry[];
  createdAt: number;
  updatedAt: number;
}

// ─── Константы ───────────────────────────────────────────────────────────────

export const HEX_COLS = 15;
export const HEX_ROWS = 15;
export const TURN_TIMER_MS = 90_000;        // 90 секунд на ход
export const DISCONNECT_TIMEOUT_MS = 300_000; // 5 минут
export const MAX_LOG = 50;

// ─── Данные классов (из client fft-3d/index.html) ────────────────────────────

export const UNIT_DEFS: Record<string, {
  hp: number; atk: number; def: number; evasion: number; armor: number;
  moveRange: number; atkRange: number; visionRange: number; isRanged: boolean;
}> = {
  knight: { hp: 40, atk: 12, def: 8,  evasion: 5,  armor: 30, moveRange: 3, atkRange: 1, visionRange: 5, isRanged: false },
  ranger: { hp: 30, atk: 10, def: 4,  evasion: 15, armor: 10, moveRange: 4, atkRange: 3, visionRange: 7, isRanged: true },
  mage:   { hp: 25, atk: 14, def: 2,  evasion: 10, armor: 0,  moveRange: 3, atkRange: 3, visionRange: 6, isRanged: true },
};

// Скиллы (портированы из client fft-3d/index.html SKILL_DEFS)
export const SKILL_DEFS: Record<string, {
  id: string; name: string; type: string; range: number; aoe: number;
  dmgMod: number; cd: number; isBasic?: boolean; effect?: string;
  targetSelf?: boolean; targetAlly?: boolean; ignoresForest?: boolean; isJump?: boolean;
}> = {
  // Knight
  sword_strike: { id: 'sword_strike', name: 'Удар',    type: 'melee',  range: 1, aoe: 0, dmgMod: 0,  cd: 0, isBasic: true },
  shield_bash:  { id: 'shield_bash',  name: 'Оглушить',type: 'melee',  range: 1, aoe: 0, dmgMod: -2, cd: 2, effect: 'stun' },
  whirlwind:    { id: 'whirlwind',    name: 'Вихрь',   type: 'melee',  range: 1, aoe: 1, dmgMod: -3, cd: 3 },
  guard:        { id: 'guard',        name: 'Заслон',  type: 'buff',   range: 0, aoe: 0, dmgMod: 0,  cd: 2, effect: 'barrier', targetSelf: true },
  push:         { id: 'push',         name: 'Толчок',  type: 'melee',  range: 1, aoe: 0, dmgMod: -4, cd: 2, effect: 'push:1' },
  // Ranger
  bow_shot:     { id: 'bow_shot',     name: 'Выстрел', type: 'ranged', range: 3, aoe: 0, dmgMod: 0,  cd: 0, isBasic: true },
  aimed_shot:   { id: 'aimed_shot',   name: 'Прицел',  type: 'ranged', range: 4, aoe: 0, dmgMod: 3,  cd: 2, ignoresForest: true },
  volley:       { id: 'volley',       name: 'Залп',    type: 'ranged', range: 3, aoe: 1, dmgMod: -2, cd: 3 },
  net:          { id: 'net',          name: 'Сеть',    type: 'ranged', range: 3, aoe: 0, dmgMod: -4, cd: 2, effect: 'immobilize' },
  // Mage
  magic_bolt:   { id: 'magic_bolt',   name: 'Импульс', type: 'magic',  range: 3, aoe: 0, dmgMod: 0,  cd: 0, isBasic: true },
  fireball:     { id: 'fireball',     name: 'Огонь',   type: 'magic',  range: 3, aoe: 1, dmgMod: -2, cd: 3 },
  frost_lance:  { id: 'frost_lance',  name: 'Лёд',     type: 'magic',  range: 3, aoe: 0, dmgMod: 2,  cd: 2, effect: 'slow' },
  heal_ally:    { id: 'heal_ally',    name: 'Лечение', type: 'heal',   range: 2, aoe: 0, dmgMod: -8, cd: 3, targetAlly: true },
  // Universal
  jump:         { id: 'jump',         name: 'Прыжок',  type: 'move',   range: 3, aoe: 0, dmgMod: 0,  cd: 2, isJump: true },
};

export const CLASS_SKILLS: Record<string, { basic: string; specials: string[] }> = {
  knight: { basic: 'sword_strike', specials: ['shield_bash', 'whirlwind', 'guard', 'jump', 'push'] },
  ranger: { basic: 'bow_shot',     specials: ['aimed_shot', 'volley', 'net', 'jump'] },
  mage:   { basic: 'magic_bolt',   specials: ['fireball', 'frost_lance', 'heal_ally', 'jump'] },
};

// ─── Начальное состояние ──────────────────────────────────────────────────────

import { generateGrid } from './map-gen';

function makeUnit(id: string, team: Team, cls: UnitClass, col: number, row: number): Unit {
  const d = UNIT_DEFS[cls];
  const cs = CLASS_SKILLS[cls];
  return {
    id,
    team,
    class: cls,
    col, row,
    hp: d.hp, maxHp: d.hp,
    atk: d.atk, def: d.def, evasion: d.evasion, armor: d.armor,
    moveRange: d.moveRange, atkRange: d.atkRange, visionRange: d.visionRange,
    isRanged: d.isRanged,
    alive: true,
    moved: false, acted: false,
    abilities: [cs.basic], // начальная способность, set-skills добавит ещё
    cooldowns: {},
    statusEffects: {},
  };
}

export function createInitialState(): GameState {
  const now = Date.now();
  const grid = generateGrid(now % 1000000);

  // Team A (host): нижние строки 13, col 6,7,8 — knight/ranger/mage
  // Team B (guest): верхние строки 1, col 6,7,8
  const units: Unit[] = [
    makeUnit('A1', 'A', 'knight', 6, 13),
    makeUnit('A2', 'A', 'ranger', 7, 13),
    makeUnit('A3', 'A', 'mage',   8, 13),
    makeUnit('B1', 'B', 'knight', 6, 1),
    makeUnit('B2', 'B', 'ranger', 7, 1),
    makeUnit('B3', 'B', 'mage',   8, 1),
  ];

  return {
    version: 0,
    phase: 'lobby',
    currentTeam: 'A',
    turnNumber: 0,
    turnDeadline: null,
    units,
    grid,
    playerA: { ready: false, lastSeenAt: now },
    playerB: { ready: false, lastSeenAt: now },
    winner: null,
    log: [],
    createdAt: now,
    updatedAt: now,
  };
}

// ─── Вспомогательные функции ──────────────────────────────────────────────────

export function addLog(state: GameState, text: string, team?: Team, type = 'info'): void {
  state.log.push({ text, team, type });
  if (state.log.length > MAX_LOG) {
    state.log.splice(0, state.log.length - MAX_LOG);
  }
}

export function checkWin(state: GameState): Team | null {
  const aliveA = state.units.filter(u => u.team === 'A' && u.alive).length;
  const aliveB = state.units.filter(u => u.team === 'B' && u.alive).length;
  if (aliveA === 0) return 'B';
  if (aliveB === 0) return 'A';
  return null;
}
