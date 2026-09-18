// FFT-3D — применение игровых действий
import { GameState, Team, Unit, SKILL_DEFS, UNIT_DEFS, TURN_TIMER_MS, CLASS_SKILLS, addLog, checkWin } from './state';
import { TERRAIN_PROPS } from './map-gen';

type ActionResult = { ok: boolean; error?: string };

// ─── Вспомогательные функции ──────────────────────────────────────────────────

function hexDist(c1: number, r1: number, c2: number, r2: number): number {
  // Axial hex distance (offset coordinates — приближение через чебышева для flat-top)
  return Math.max(Math.abs(c1 - c2), Math.abs(r1 - r2), Math.abs((c1 - r1) - (c2 - r2)));
}

function getCell(state: GameState, col: number, row: number) {
  return (state.grid[row] && state.grid[row][col]) ? state.grid[row][col] : { type: 'grass', height: 0 };
}

function isBlocked(state: GameState, col: number, row: number): boolean {
  const cell = getCell(state, col, row);
  const props = TERRAIN_PROPS[cell.type];
  if (!props) return false;
  return props.blocksMove;
}

function findUnit(state: GameState, unitId: string): Unit | undefined {
  return state.units.find(u => u.id === unitId);
}

function findUnitAt(state: GameState, col: number, row: number): Unit | undefined {
  return state.units.find(u => u.col === col && u.row === row && u.alive);
}

// Проверка занятости клетки другим юнитом
function isCellOccupied(state: GameState, col: number, row: number, exceptId?: string): boolean {
  return state.units.some(u => u.alive && u.col === col && u.row === row && u.id !== exceptId);
}

// Расчёт урона: formула ATK + dmgMod - DEF * (1 - armor/100), с учётом evasion
function rollDamage(attacker: Unit, target: Unit, dmgMod: number): { damage: number; evaded: boolean } {
  // Evasion roll
  const evadeRoll = Math.random() * 100;
  if (evadeRoll < target.evasion) return { damage: 0, evaded: true };

  // Barrier absorbs first hit
  let rawDmg = Math.max(1, attacker.atk + dmgMod - target.def);
  const armorReduction = target.armor / 100;
  let damage = Math.round(rawDmg * (1 - armorReduction));
  if (target.statusEffects.barrier && target.statusEffects.barrier > 0) {
    damage = Math.max(0, damage - target.statusEffects.barrier);
    target.statusEffects.barrier = undefined;
  }
  return { damage: Math.max(0, damage), evaded: false };
}

// Уменьшение кулдаунов (вызывается при смене хода)
function tickCooldowns(state: GameState, team: Team): void {
  for (const unit of state.units) {
    if (unit.team !== team) continue;
    for (const key of Object.keys(unit.cooldowns)) {
      if (unit.cooldowns[key] > 0) unit.cooldowns[key]--;
      if (unit.cooldowns[key] <= 0) delete unit.cooldowns[key];
    }
    // Tick status effects
    if (unit.statusEffects.stun) unit.statusEffects.stun = false;
    if (unit.statusEffects.slow) unit.statusEffects.slow = false;
  }
}

// ─── Главная функция applyAction ─────────────────────────────────────────────

export function applyAction(
  state: GameState,
  actorTeam: Team,
  action: Record<string, unknown>,
): ActionResult {
  const type = action.type as string;

  switch (type) {
    case 'set-skills': return applySetSkills(state, actorTeam, action);
    case 'ready':      return applyReady(state, actorTeam);
    case 'move':       return applyMove(state, actorTeam, action);
    case 'attack':     return applyAttack(state, actorTeam, action);
    case 'jump':       return applyJump(state, actorTeam, action);
    case 'push':       return applyPush(state, actorTeam, action);
    case 'skip-unit':  return applySkipUnit(state, actorTeam, action);
    case 'end-turn':   return applyEndTurn(state, actorTeam);
    case 'resign':     return applyResign(state, actorTeam);
    default:           return { ok: false, error: `Неизвестное действие: ${type}` };
  }
}

// ─── Действие: set-skills ─────────────────────────────────────────────────────

function applySetSkills(state: GameState, actorTeam: Team, action: Record<string, unknown>): ActionResult {
  if (state.phase !== 'skill-selection') {
    return { ok: false, error: 'Выбор скиллов доступен только в фазе skill-selection' };
  }

  const unitId = action.unitId as string;
  const skills = action.skills as string[];

  if (!unitId || !Array.isArray(skills)) {
    return { ok: false, error: 'Требуется unitId и skills[]' };
  }

  const unit = findUnit(state, unitId);
  if (!unit) return { ok: false, error: 'Юнит не найден' };
  if (unit.team !== actorTeam) return { ok: false, error: 'Нельзя управлять чужим юнитом' };

  const cs = CLASS_SKILLS[unit.class];
  if (!cs) return { ok: false, error: 'Неизвестный класс' };

  // Валидируем: все скиллы должны быть доступны для класса + basic всегда включён
  const validSkills = [cs.basic, ...cs.specials];
  for (const sk of skills) {
    if (!validSkills.includes(sk)) {
      return { ok: false, error: `Скилл ${sk} недоступен для класса ${unit.class}` };
    }
  }

  // Базовый скилл всегда в abilities, specials выбираются (max 2)
  const specials = skills.filter(s => s !== cs.basic).slice(0, 2);
  unit.abilities = [cs.basic, ...specials];

  addLog(state, `${unit.id} выбрал скиллы: ${unit.abilities.join(', ')}`, actorTeam, 'skills');
  state.version++;
  state.updatedAt = Date.now();
  return { ok: true };
}

// ─── Действие: ready ─────────────────────────────────────────────────────────

function applyReady(state: GameState, actorTeam: Team): ActionResult {
  if (state.phase !== 'skill-selection') {
    return { ok: false, error: 'Ready только в фазе skill-selection' };
  }

  if (actorTeam === 'A') state.playerA.ready = true;
  else state.playerB.ready = true;

  addLog(state, `Команда ${actorTeam} готова`, actorTeam, 'ready');

  // Оба готовы — переходим в battle
  if (state.playerA.ready && state.playerB.ready) {
    state.phase = 'battle';
    state.currentTeam = 'A';
    state.turnNumber = 1;
    state.turnDeadline = Date.now() + TURN_TIMER_MS;
    addLog(state, 'Битва начинается! Ход команды A', undefined, 'phase');
  }

  state.version++;
  state.updatedAt = Date.now();
  return { ok: true };
}

// ─── Действие: move ──────────────────────────────────────────────────────────

function applyMove(state: GameState, actorTeam: Team, action: Record<string, unknown>): ActionResult {
  if (state.phase !== 'battle') return { ok: false, error: 'Ход только в battle' };
  if (state.currentTeam !== actorTeam) return { ok: false, error: 'Не ваш ход' };

  const unitId = action.unitId as string;
  const targetCol = action.targetCol as number;
  const targetRow = action.targetRow as number;

  const unit = findUnit(state, unitId);
  if (!unit) return { ok: false, error: 'Юнит не найден' };
  if (unit.team !== actorTeam) return { ok: false, error: 'Нельзя управлять чужим юнитом' };
  if (!unit.alive) return { ok: false, error: 'Юнит мёртв' };
  if (unit.moved) return { ok: false, error: 'Юнит уже двигался в этот ход' };
  if (unit.statusEffects.stun || unit.statusEffects.immobilize) {
    return { ok: false, error: 'Юнитездиммобилизован/оглушён' };
  }

  const dist = hexDist(unit.col, unit.row, targetCol, targetRow);
  const moveRange = unit.statusEffects.slow ? Math.ceil(unit.moveRange / 2) : unit.moveRange;
  if (dist > moveRange) {
    return { ok: false, error: `Слишком далеко. Дальность: ${moveRange}` };
  }

  if (isBlocked(state, targetCol, targetRow)) {
    return { ok: false, error: 'Клетка непроходима' };
  }

  if (isCellOccupied(state, targetCol, targetRow, unitId)) {
    return { ok: false, error: 'Клетка занята' };
  }

  // Terrain damage on landing
  const targetCell = getCell(state, targetCol, targetRow);
  const props = TERRAIN_PROPS[targetCell.type];
  if (props && props.damagePerTurn > 0) {
    unit.hp = Math.max(0, unit.hp - props.damagePerTurn);
    if (unit.hp === 0) unit.alive = false;
    addLog(state, `${unit.id} получил ${props.damagePerTurn} урона от ${targetCell.type}`, actorTeam, 'damage');
  }

  unit.col = targetCol;
  unit.row = targetRow;
  unit.moved = true;

  addLog(state, `${unit.id} переместился на (${targetCol},${targetRow})`, actorTeam, 'move');

  const winner = checkWin(state);
  if (winner) {
    state.winner = winner;
    state.phase = 'ended';
    addLog(state, `Победа команды ${winner}!`, winner, 'win');
  }

  state.version++;
  state.updatedAt = Date.now();
  return { ok: true };
}

// ─── Действие: attack ────────────────────────────────────────────────────────

function applyAttack(state: GameState, actorTeam: Team, action: Record<string, unknown>): ActionResult {
  if (state.phase !== 'battle') return { ok: false, error: 'Атака только в battle' };
  if (state.currentTeam !== actorTeam) return { ok: false, error: 'Не ваш ход' };

  const unitId = action.unitId as string;
  const targetUnitId = action.targetUnitId as string;
  const skillId = action.skillId as string | undefined;

  const attacker = findUnit(state, unitId);
  if (!attacker) return { ok: false, error: 'Атакующий не найден' };
  if (attacker.team !== actorTeam) return { ok: false, error: 'Нельзя управлять чужим юнитом' };
  if (!attacker.alive) return { ok: false, error: 'Атакующий мёртв' };
  if (attacker.acted) return { ok: false, error: 'Юнит уже действовал в этот ход' };
  if (attacker.statusEffects.stun) return { ok: false, error: 'Юнит оглушён' };

  const target = findUnit(state, targetUnitId);
  if (!target) return { ok: false, error: 'Цель не найдена' };
  if (!target.alive) return { ok: false, error: 'Цель уже мертва' };

  // Выбор скилла
  const useSkillId = skillId || attacker.abilities[0];
  if (!attacker.abilities.includes(useSkillId)) {
    return { ok: false, error: `Скилл ${useSkillId} недоступен юниту` };
  }

  const skill = SKILL_DEFS[useSkillId];
  if (!skill) return { ok: false, error: `Неизвестный скилл: ${useSkillId}` };

  // Кулдаун
  if (attacker.cooldowns[useSkillId] && attacker.cooldowns[useSkillId] > 0) {
    return { ok: false, error: `Скилл ${useSkillId} на кулдауне (${attacker.cooldowns[useSkillId]} ходов)` };
  }

  // Heal ally — нельзя атаковать врагов
  if (skill.targetAlly && target.team === actorTeam) {
    // Лечение союзника
    const healAmt = Math.abs(skill.dmgMod);
    target.hp = Math.min(target.maxHp, target.hp + healAmt);
    addLog(state, `${attacker.id} вылечил ${target.id} на ${healAmt} HP`, actorTeam, 'heal');
  } else if (skill.targetAlly) {
    return { ok: false, error: 'Этот скилл только на союзников' };
  } else if (skill.targetSelf) {
    // Guard/Barrier — на себя
    if (target.id !== attacker.id) return { ok: false, error: 'Этот скилл применяется только на себя' };
    attacker.statusEffects.barrier = 10;
    addLog(state, `${attacker.id} поставил барьер`, actorTeam, 'buff');
  } else {
    // Атака противника
    if (target.team === actorTeam) {
      return { ok: false, error: 'Нельзя атаковать союзника этим скиллом' };
    }

    const dist = hexDist(attacker.col, attacker.row, target.col, target.row);
    if (dist > skill.range) {
      return { ok: false, error: `Цель вне дальности (${dist} > ${skill.range})` };
    }

    // AOE — атакуем всех вокруг цели в радиусе aoe
    const targets: Unit[] = skill.aoe > 0
      ? state.units.filter(u =>
          u.alive && u.team !== actorTeam &&
          hexDist(target.col, target.row, u.col, u.row) <= skill.aoe
        )
      : [target];

    for (const tgt of targets) {
      const { damage, evaded } = rollDamage(attacker, tgt, skill.dmgMod);
      if (evaded) {
        addLog(state, `${tgt.id} уклонился от атаки ${attacker.id}`, tgt.team, 'evade');
      } else {
        tgt.hp = Math.max(0, tgt.hp - damage);
        if (tgt.hp === 0) tgt.alive = false;
        addLog(state, `${attacker.id} атаковал ${tgt.id} (${useSkillId}): -${damage} HP`, actorTeam, 'damage');
      }

      // Применяем эффект скилла
      if (skill.effect && !evaded) {
        if (skill.effect === 'stun') tgt.statusEffects.stun = true;
        if (skill.effect === 'immobilize') tgt.statusEffects.immobilize = true;
        if (skill.effect === 'slow') tgt.statusEffects.slow = true;
      }
    }
  }

  // Кулдаун и acted
  if (skill.cd > 0) attacker.cooldowns[useSkillId] = skill.cd;
  attacker.acted = true;

  const winner = checkWin(state);
  if (winner) {
    state.winner = winner;
    state.phase = 'ended';
    addLog(state, `Победа команды ${winner}!`, winner, 'win');
  }

  state.version++;
  state.updatedAt = Date.now();
  return { ok: true };
}

// ─── Действие: jump ──────────────────────────────────────────────────────────

function applyJump(state: GameState, actorTeam: Team, action: Record<string, unknown>): ActionResult {
  if (state.phase !== 'battle') return { ok: false, error: 'Прыжок только в battle' };
  if (state.currentTeam !== actorTeam) return { ok: false, error: 'Не ваш ход' };

  const unitId = action.unitId as string;
  const targetCol = action.targetCol as number;
  const targetRow = action.targetRow as number;

  const unit = findUnit(state, unitId);
  if (!unit) return { ok: false, error: 'Юнит не найден' };
  if (unit.team !== actorTeam) return { ok: false, error: 'Нельзя управлять чужим юнитом' };
  if (!unit.alive) return { ok: false, error: 'Юнит мёртв' };
  if (!unit.abilities.includes('jump')) return { ok: false, error: 'Нет скилла jump' };
  if (unit.moved) return { ok: false, error: 'Уже двигался в этот ход' };
  if (unit.statusEffects.stun) return { ok: false, error: 'Юнит оглушён' };
  if (unit.cooldowns['jump'] && unit.cooldowns['jump'] > 0) {
    return { ok: false, error: `jump на кулдауне (${unit.cooldowns['jump']} ходов)` };
  }

  const skill = SKILL_DEFS['jump'];
  const dist = hexDist(unit.col, unit.row, targetCol, targetRow);
  if (dist > skill.range) return { ok: false, error: `Слишком далеко для прыжка` };

  if (isCellOccupied(state, targetCol, targetRow, unitId)) {
    return { ok: false, error: 'Клетка занята' };
  }

  // Fall damage при приземлении ниже
  const fromHeight = getCell(state, unit.col, unit.row).height;
  const toHeight = getCell(state, targetCol, targetRow).height;
  const heightDiff = fromHeight - toHeight;
  if (heightDiff > 1) {
    const fallDmg = (heightDiff - 1) * 5;
    unit.hp = Math.max(0, unit.hp - fallDmg);
    if (unit.hp === 0) unit.alive = false;
    addLog(state, `${unit.id} получил ${fallDmg} урона от падения`, actorTeam, 'damage');
  }

  unit.col = targetCol;
  unit.row = targetRow;
  unit.moved = true;
  unit.cooldowns['jump'] = skill.cd;

  addLog(state, `${unit.id} прыгнул на (${targetCol},${targetRow})`, actorTeam, 'jump');

  const winner = checkWin(state);
  if (winner) {
    state.winner = winner;
    state.phase = 'ended';
    addLog(state, `Победа команды ${winner}!`, winner, 'win');
  }

  state.version++;
  state.updatedAt = Date.now();
  return { ok: true };
}

// ─── Действие: push ──────────────────────────────────────────────────────────

function applyPush(state: GameState, actorTeam: Team, action: Record<string, unknown>): ActionResult {
  if (state.phase !== 'battle') return { ok: false, error: 'Толчок только в battle' };
  if (state.currentTeam !== actorTeam) return { ok: false, error: 'Не ваш ход' };

  const unitId = action.unitId as string;
  const targetUnitId = action.targetUnitId as string;

  const attacker = findUnit(state, unitId);
  if (!attacker) return { ok: false, error: 'Атакующий не найден' };
  if (attacker.team !== actorTeam) return { ok: false, error: 'Нельзя управлять чужим юнитом' };
  if (!attacker.alive) return { ok: false, error: 'Атакующий мёртв' };
  if (attacker.acted) return { ok: false, error: 'Уже действовал в этот ход' };
  if (!attacker.abilities.includes('push')) return { ok: false, error: 'Нет скилла push' };
  if (attacker.cooldowns['push'] && attacker.cooldowns['push'] > 0) {
    return { ok: false, error: `push на кулдауне (${attacker.cooldowns['push']} ходов)` };
  }

  const target = findUnit(state, targetUnitId);
  if (!target) return { ok: false, error: 'Цель не найдена' };
  if (!target.alive) return { ok: false, error: 'Цель уже мертва' };
  if (target.team === actorTeam) return { ok: false, error: 'Нельзя толкнуть союзника' };

  const dist = hexDist(attacker.col, attacker.row, target.col, target.row);
  const skill = SKILL_DEFS['push'];
  if (dist > skill.range) return { ok: false, error: 'Цель вне дальности толчка' };

  // Урон от толчка
  const { damage, evaded } = rollDamage(attacker, target, skill.dmgMod);
  if (!evaded) {
    target.hp = Math.max(0, target.hp - damage);
    if (target.hp === 0) target.alive = false;
  }

  // Смещение цели (push:1 — на 1 клетку от атакующего)
  const dc = target.col - attacker.col;
  const dr = target.row - attacker.row;
  const norm = Math.max(Math.abs(dc), Math.abs(dr)) || 1;
  const pushCol = target.col + Math.round(dc / norm);
  const pushRow = target.row + Math.round(dr / norm);

  const fromHeight = getCell(state, target.col, target.row).height;

  if (
    pushCol >= 0 && pushCol < state.grid[0].length &&
    pushRow >= 0 && pushRow < state.grid.length &&
    !isBlocked(state, pushCol, pushRow) &&
    !isCellOccupied(state, pushCol, pushRow, target.id)
  ) {
    const toHeight = getCell(state, pushCol, pushRow).height;
    target.col = pushCol;
    target.row = pushRow;

    // Fall damage при падении
    const fallDiff = fromHeight - toHeight;
    if (fallDiff > 1) {
      const fallDmg = (fallDiff - 1) * 5;
      target.hp = Math.max(0, target.hp - fallDmg);
      if (target.hp === 0) target.alive = false;
      addLog(state, `${target.id} получил ${fallDmg} урона от падения при толчке`, target.team, 'damage');
    }
  }

  addLog(state, `${attacker.id} толкнул ${target.id}: -${damage} HP`, actorTeam, 'push');
  attacker.acted = true;
  attacker.cooldowns['push'] = skill.cd;

  const winner = checkWin(state);
  if (winner) {
    state.winner = winner;
    state.phase = 'ended';
    addLog(state, `Победа команды ${winner}!`, winner, 'win');
  }

  state.version++;
  state.updatedAt = Date.now();
  return { ok: true };
}

// ─── Действие: skip-unit ─────────────────────────────────────────────────────

function applySkipUnit(state: GameState, actorTeam: Team, action: Record<string, unknown>): ActionResult {
  if (state.phase !== 'battle') return { ok: false, error: 'Только в battle' };
  if (state.currentTeam !== actorTeam) return { ok: false, error: 'Не ваш ход' };

  const unitId = action.unitId as string;
  const unit = findUnit(state, unitId);
  if (!unit) return { ok: false, error: 'Юнит не найден' };
  if (unit.team !== actorTeam) return { ok: false, error: 'Нельзя управлять чужим юнитом' };
  if (!unit.alive) return { ok: false, error: 'Юнит мёртв' };

  unit.moved = true;
  unit.acted = true;

  addLog(state, `${unit.id} пропустил ход`, actorTeam, 'skip');
  state.version++;
  state.updatedAt = Date.now();
  return { ok: true };
}

// ─── Действие: end-turn ──────────────────────────────────────────────────────

function applyEndTurn(state: GameState, actorTeam: Team): ActionResult {
  if (state.phase !== 'battle') return { ok: false, error: 'Только в battle' };
  if (state.currentTeam !== actorTeam) return { ok: false, error: 'Не ваш ход' };

  // Тикаем кулдауны команды которая заканчивает ход
  tickCooldowns(state, actorTeam);

  // Сбрасываем moved/acted для текущей команды
  for (const unit of state.units) {
    if (unit.team === actorTeam) {
      unit.moved = false;
      unit.acted = false;
      // Сброс иммобилайза (длится 1 ход)
      if (unit.statusEffects.immobilize) unit.statusEffects.immobilize = false;
    }
  }

  // Меняем команду
  state.currentTeam = actorTeam === 'A' ? 'B' : 'A';
  state.turnNumber++;
  state.turnDeadline = Date.now() + TURN_TIMER_MS;

  addLog(state, `Ход команды ${state.currentTeam} (ход #${state.turnNumber})`, state.currentTeam, 'turn');

  state.version++;
  state.updatedAt = Date.now();
  return { ok: true };
}

// ─── Действие: resign ────────────────────────────────────────────────────────

function applyResign(state: GameState, actorTeam: Team): ActionResult {
  if (state.phase === 'ended') return { ok: false, error: 'Игра уже завершена' };

  const winner: Team = actorTeam === 'A' ? 'B' : 'A';
  state.winner = winner;
  state.phase = 'ended';

  addLog(state, `Команда ${actorTeam} сдалась. Победа команды ${winner}!`, winner, 'resign');

  state.version++;
  state.updatedAt = Date.now();
  return { ok: true };
}

// ─── Timer sweep: авто-завершение хода по дедлайну ───────────────────────────

export function checkAndApplyTimerSweep(state: GameState): boolean {
  if (state.phase !== 'battle') return false;
  if (!state.turnDeadline) return false;
  if (Date.now() < state.turnDeadline) return false;

  addLog(state, `Время хода команды ${state.currentTeam} истекло — авто-завершение`, state.currentTeam, 'timeout');
  applyEndTurn(state, state.currentTeam);
  return true;
}

// ─── Disconnect check ────────────────────────────────────────────────────────

export function checkDisconnect(state: GameState, disconnectTimeoutMs: number): boolean {
  if (state.phase !== 'battle') return false;

  const now = Date.now();
  const currentMeta = state.currentTeam === 'A' ? state.playerA : state.playerB;

  if (now - currentMeta.lastSeenAt > disconnectTimeoutMs) {
    const winner: Team = state.currentTeam === 'A' ? 'B' : 'A';
    state.winner = winner;
    state.phase = 'ended';
    addLog(state, `Команда ${state.currentTeam} отключилась. Победа команды ${winner}!`, winner, 'disconnect');
    state.version++;
    state.updatedAt = now;
    return true;
  }

  return false;
}
