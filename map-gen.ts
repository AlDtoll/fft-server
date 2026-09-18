// FFT-3D — генерация карты (порт из client fft-3d/index.html)
// Детерминированная генерация по seed

import { GridCell, HEX_COLS, HEX_ROWS } from './state';

// Terrain props (из client)
export const TERRAIN_PROPS: Record<string, {
  moveCost: number; blocksMove: boolean; damagePerTurn: number; evasionBonus?: number;
}> = {
  grass:         { moveCost: 1,         blocksMove: false, damagePerTurn: 0 },
  forest:        { moveCost: 1,         blocksMove: false, damagePerTurn: 0, evasionBonus: 15 },
  rock:          { moveCost: Infinity,  blocksMove: true,  damagePerTurn: 0 },
  deep_water:    { moveCost: Infinity,  blocksMove: true,  damagePerTurn: 0 },
  shallow_water: { moveCost: 2,         blocksMove: false, damagePerTurn: 0 },
  fire:          { moveCost: 1,         blocksMove: false, damagePerTurn: 5 },
  swamp:         { moveCost: 2,         blocksMove: false, damagePerTurn: 0 },
};

// Синусоидальный elevation noise (идентично client)
function elevNoise(col: number, row: number): number {
  const raw = (Math.sin(col * 0.45 + 0.3) + Math.cos(row * 0.38 + 0.7) +
               Math.sin((col + row) * 0.25) * 0.6 + 2.6) / 5.2;
  return Math.floor(raw * 4); // 0..3
}

// Лёгкий PRNG на основе seed (LCG)
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xFFFFFFFF;
  };
}

// Патчи terrain — аналог фиксированных patches в client, но смещённые по seed
function buildPatches(rnd: () => number): Array<{ r: number; c: number; t: string; h: number }> {
  // Базовые патчи из client (фиксированные позиции)
  const base = [
    // deep_water
    {r:2,c:2,t:'deep_water',h:-1},{r:2,c:3,t:'deep_water',h:-1},{r:3,c:2,t:'deep_water',h:-1},
    {r:3,c:3,t:'deep_water',h:-1},{r:4,c:2,t:'deep_water',h:-1},
    {r:11,c:4,t:'deep_water',h:-1},{r:11,c:5,t:'deep_water',h:-1},{r:12,c:4,t:'deep_water',h:-1},
    // shallow_water
    {r:2,c:4,t:'shallow_water',h:0},{r:3,c:4,t:'shallow_water',h:0},{r:4,c:3,t:'shallow_water',h:0},
    {r:12,c:5,t:'shallow_water',h:0},{r:11,c:6,t:'shallow_water',h:0},
    // forest
    {r:1,c:10,t:'forest',h:1},{r:1,c:11,t:'forest',h:0},{r:2,c:10,t:'forest',h:1},{r:2,c:11,t:'forest',h:1},
    {r:3,c:11,t:'forest',h:0},{r:4,c:10,t:'forest',h:1},{r:5,c:11,t:'forest',h:0},
    {r:8,c:1,t:'forest',h:0},{r:8,c:2,t:'forest',h:1},{r:9,c:1,t:'forest',h:0},
    {r:6,c:1,t:'forest',h:1},{r:7,c:2,t:'forest',h:0},
    // rock
    {r:5,c:3,t:'rock',h:2},{r:5,c:4,t:'rock',h:3},{r:6,c:3,t:'rock',h:3},{r:6,c:4,t:'rock',h:2},
    {r:0,c:5,t:'rock',h:3},{r:0,c:6,t:'rock',h:2},{r:1,c:5,t:'rock',h:3},
    // swamp
    {r:9,c:10,t:'swamp',h:0},{r:9,c:11,t:'swamp',h:0},{r:10,c:10,t:'swamp',h:0},
    {r:10,c:11,t:'swamp',h:0},{r:10,c:12,t:'swamp',h:0},
    {r:0,c:13,t:'swamp',h:0},{r:1,c:13,t:'swamp',h:0},{r:0,c:14,t:'swamp',h:0},
    // fire
    {r:7,c:7,t:'fire',h:0},{r:7,c:8,t:'fire',h:0},
  ];

  // Небольшое смещение рядов по seed для вариативности
  const rowShift = Math.floor(rnd() * 3) - 1; // -1, 0 или +1

  return base.map(p => {
    const nr = Math.max(0, Math.min(HEX_ROWS - 1, p.r + rowShift));
    return { ...p, r: nr };
  });
}

export function generateGrid(seed: number): GridCell[][] {
  const rnd = makePrng(seed);
  const grid: GridCell[][] = [];

  // Базовый elevation noise
  for (let r = 0; r < HEX_ROWS; r++) {
    grid.push([]);
    for (let c = 0; c < HEX_COLS; c++) {
      const h = elevNoise(c, r);
      grid[r].push({ type: 'grass', height: Math.min(h, 3) });
    }
  }

  // Применяем terrain patches
  const patches = buildPatches(rnd);
  for (const p of patches) {
    if (grid[p.r] && grid[p.r][p.c] !== undefined) {
      grid[p.r][p.c] = { type: p.t, height: p.h };
    }
  }

  // Сбрасываем стартовые позиции команд до grass, чтобы юниты стояли на проходимых клетках
  const startPositions = [
    { r: 13, c: 6 }, { r: 13, c: 7 }, { r: 13, c: 8 },
    { r: 1,  c: 6 }, { r: 1,  c: 7 }, { r: 1,  c: 8 },
  ];
  for (const pos of startPositions) {
    if (grid[pos.r] && grid[pos.r][pos.c] !== undefined) {
      grid[pos.r][pos.c] = { type: 'grass', height: 0 };
    }
  }

  return grid;
}
