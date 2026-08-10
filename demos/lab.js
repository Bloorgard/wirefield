// Общая обвязка для демо альтернативной физики жгутов.
// Даёт одинаковую сцену, камеру, рендер, ввод и замер времени всем солверам,
// чтобы сравнение шло по механике, а не по обвязке.

import {COLORS} from '../src/model.js';

export const CELL = 44;
export const BG = '#102cff';

// Цвета жгутов берём из палитры редактора, минус фон и почти чёрный.
export const PALETTE = COLORS.filter(color => color !== '#102cff' && color !== '#0b1118');

export const WIRE_WIDTH = CELL;        // жгут толщиной в клетку, как в редакторе
export const PIN_RADIUS = CELL / 2;    // пин радиусом в полклетки
export const CLEARANCE = CELL * 1.06;  // тот же зазор, что в src/collision.js

// ---------------------------------------------------------------- сцена

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = state + 0x6d2b79f5 | 0;
    let t = Math.imul(state ^ state >>> 15, 1 | state);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Детерминированная сцена: решётка стартовых пинов, часть жгутов с закреплённым хвостом.
export function makeScene(count, seed = 11) {
  const random = mulberry32(seed);
  const columns = Math.max(4, Math.round(Math.sqrt(count * 1.7)));
  const taken = new Set();
  const key = (x, y) => x * 100003 + y;
  const wires = [];
  for (let index = 0; index < count; index++) {
    const gx = index % columns;
    const gy = Math.floor(index / columns);
    const x = 2 + gx * 5 + (random() < 0.5 ? 0 : 1);
    const y = 2 + gy * 9 + Math.floor(random() * 3);
    if (taken.has(key(x, y))) continue;
    taken.add(key(x, y));
    const color = PALETTE[Math.floor(random() * PALETTE.length)];
    if (random() < 0.45) {
      const endX = x + Math.round((random() * 2 - 1) * 3);
      const endY = y + 2 + Math.floor(random() * 4);
      if (endX > 0 && !taken.has(key(endX, endY))) {
        taken.add(key(endX, endY));
        const span = Math.hypot(endX - x, endY - y);
        const length = Math.max(1, Math.round(span * (1.08 + random() * 0.55) * 2) / 2);
        wires.push({id: 'w' + index, x, y, endX, endY, length, color});
        continue;
      }
    }
    wires.push({id: 'w' + index, x, y, length: 3 + Math.round(random() * 9), color});
  }
  return wires;
}

// Число внутренних точек — та же формула, что у редактора.
export function segmentCount(wire) {
  return Math.max(4, Math.min(64, Math.ceil(wire.length * 1.35)));
}

// Общий буфер цепочек для солверов, которые работают частицами.
// Всё в плоских типизированных массивах: x и y лежат рядом, обход линейный.
export function createChains(lab) {
  const wireCount = lab.wires.length;
  const offset = new Int32Array(wireCount + 1);
  let total = 0;
  lab.wires.forEach((wire, index) => {
    offset[index] = total;
    total += segmentCount(wire);
  });
  offset[wireCount] = total;

  const chains = {
    offset,
    total,
    pos: new Float32Array(total * 2),
    prev: new Float32Array(total * 2),
    vel: new Float32Array(total * 2),
    invMass: new Float32Array(total),
    rest: new Float32Array(wireCount),
    pinned: new Uint8Array(wireCount)
  };

  lab.wires.forEach((wire, index) => {
    const first = offset[index];
    const count = offset[index + 1] - first;
    const startX = lab.pinX[lab.startPin[index]];
    const startY = lab.pinY[lab.startPin[index]];
    const tail = lab.tailPin[index];
    chains.pinned[index] = tail >= 0 ? 1 : 0;
    const endX = tail >= 0 ? lab.pinX[tail] : startX;
    const endY = tail >= 0 ? lab.pinY[tail] : startY + wire.length * CELL;
    chains.rest[index] = wire.length * CELL / (count - 1);

    // Провисание в начальном состоянии. Прямая линия между двумя пинами —
    // положение неустойчивого равновесия: боковой силы нет, и жгут со слабиной
    // сжимается вместо того, чтобы выгнуться. Параболическая заготовка снимает
    // и симметрию, и стартовый переходный процесс.
    const chordX = endX - startX;
    const chordY = endY - startY;
    const chord = Math.hypot(chordX, chordY);
    const rope = wire.length * CELL;
    let sagX = 0;
    let sagY = 0;
    if (chains.pinned[index] && chord > 1e-6 && rope > chord) {
      const depth = Math.sqrt(3 * chord * (rope - chord) / 8);
      let dirX = -chordY / chord;
      let dirY = chordX / chord;
      if (dirY < 0 || (dirY === 0 && dirX < 0)) {
        dirX = -dirX;
        dirY = -dirY;
      }
      sagX = dirX * depth;
      sagY = dirY * depth;
    }

    for (let k = 0; k < count; k++) {
      const t = k / (count - 1);
      const bulge = 4 * t * (1 - t);
      const at = (first + k) * 2;
      chains.pos[at] = chains.prev[at] = startX + chordX * t + sagX * bulge;
      chains.pos[at + 1] = chains.prev[at + 1] = startY + chordY * t + sagY * bulge;
      chains.invMass[first + k] = 1;
    }
    chains.invMass[first] = 0;
    if (chains.pinned[index]) chains.invMass[offset[index + 1] - 1] = 0;
  });
  return chains;
}

// Худшая относительная ошибка длины сегмента по всей сцене, в процентах.
export function maxStretch(lab, chains) {
  let worst = 0;
  for (let index = 0; index < lab.wires.length; index++) {
    const first = chains.offset[index];
    const last = chains.offset[index + 1] - 1;
    const rest = chains.rest[index];
    for (let k = first; k < last; k++) {
      const dx = chains.pos[k * 2 + 2] - chains.pos[k * 2];
      const dy = chains.pos[k * 2 + 3] - chains.pos[k * 2 + 1];
      const error = Math.abs(Math.hypot(dx, dy) - rest) / rest;
      if (error > worst) worst = error;
    }
  }
  return worst * 100;
}

// ---------------------------------------------------------------- сетка пинов

// Равномерная сетка на плоских массивах: counting sort вместо Map из бакетов.
// Пересобирается каждый кадр, потому что перетаскиваемый пин двигается.
export class PinGrid {
  constructor(cellSize) {
    this.cellSize = cellSize;
    this.counts = new Int32Array(0);
    this.items = new Int32Array(0);
    this.cols = 0;
    this.rows = 0;
    this.minX = 0;
    this.minY = 0;
  }

  build(px, py, count) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < count; i++) {
      if (px[i] < minX) minX = px[i];
      if (px[i] > maxX) maxX = px[i];
      if (py[i] < minY) minY = py[i];
      if (py[i] > maxY) maxY = py[i];
    }
    if (!count) {
      minX = minY = maxX = maxY = 0;
    }
    this.minX = minX;
    this.minY = minY;
    this.cols = Math.max(1, Math.floor((maxX - minX) / this.cellSize) + 1);
    this.rows = Math.max(1, Math.floor((maxY - minY) / this.cellSize) + 1);
    const cells = this.cols * this.rows;
    if (this.counts.length !== cells + 1) this.counts = new Int32Array(cells + 1);
    else this.counts.fill(0);
    if (this.items.length !== count) this.items = new Int32Array(count);

    for (let i = 0; i < count; i++) this.counts[this.cellOf(px[i], py[i]) + 1]++;
    for (let c = 0; c < cells; c++) this.counts[c + 1] += this.counts[c];
    const cursor = this.counts.slice(0, cells);
    for (let i = 0; i < count; i++) this.items[cursor[this.cellOf(px[i], py[i])]++] = i;
    this.count = count;
  }

  cellOf(x, y) {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.minX) / this.cellSize)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.minY) / this.cellSize)));
    return cy * this.cols + cx;
  }

  // Готовит диапазон бакетов в qx0..qy1. Обход оставлен вызывающему коду:
  // колбэк здесь означал бы аллокацию замыкания на каждую частицу каждого подшага.
  range(minX, minY, maxX, maxY) {
    this.qx0 = Math.max(0, Math.floor((minX - this.minX) / this.cellSize));
    this.qx1 = Math.min(this.cols - 1, Math.floor((maxX - this.minX) / this.cellSize));
    this.qy0 = Math.max(0, Math.floor((minY - this.minY) / this.cellSize));
    this.qy1 = Math.min(this.rows - 1, Math.floor((maxY - this.minY) / this.cellSize));
    return this;
  }
}

// Контакт «отрезок ↔ пин» как позиционная проекция, общая для солверов с частицами.
//
// Утолщать точки вместо отрезков заманчиво — запрос дешевле, — но жгут, висящий
// ровно над пином, попадает в симметричный тупик: радиальная нормаль от пина к
// точке направлена вдоль цепочки, и жгут выталкивает сам себя вдоль своей оси
// вместо того, чтобы обогнуть препятствие. У отрезка вектор до ближайшей точки
// перпендикулярен ему по построению, поэтому пин всегда толкает жгут вбок.
//
// `prev` обязателен для солверов, которые потом берут скорость как `(pos − prev)/h`.
// Выталкивание — это исправление проникновения, а не удар: если сдвинуть только
// `pos`, поправка в 14 px на подшаге длиной 1/480 c превратится в 6700 px/с и
// начнёт накачивать сцену энергией. Сдвигая `prev` на тот же вектор, мы делаем
// контакт нейтральным по скорости, а отскок и трение оставляем отдельному
// проходу, где ими можно управлять. Ровно этому служит `point.ox += dx` в
// `src/collision.js` — строчка, которая выглядит как смешение слоёв, а на деле
// является здесь единственной защитой от накачки.
// `slop` и `beta` не менее важны, чем `prev`. Жгут, лёгший ровно на границу
// зазора, без них получает поправку в доли пикселя каждый кадр: скорости она не
// добавляет, но переносит жгут вверх против тяжести — и качает его через
// позицию, как параметрический маятник. Допуск `slop` разрешает мизерное
// проникновение и даёт контакту наконец успокоиться, `beta` растягивает
// исправление на несколько кадров. В `src/collision.js` есть аналог `beta`
// (`correction`), но допуска нет.
export function solveSegmentPins(lab, chains, options) {
  const clearance = options.clearance;
  const contactFlag = options.flag || null;
  const contactNormal = options.normal || null;
  const maxPush = options.maxPush ?? clearance * 0.3;
  const prev = options.prev || null;
  const slop = options.slop ?? lab.cell * 0.04;
  const beta = options.beta ?? 0.4;
  const {pos, invMass, offset} = chains;
  const grid = lab.grid;
  const counts = grid.counts;
  const items = grid.items;
  const limit = clearance * clearance;
  let contacts = 0;

  for (let wire = 0; wire < lab.wires.length; wire++) {
    const to = offset[wire + 1] - 1;
    for (let k = offset[wire]; k < to; k++) {
      const a = k * 2;
      const b = a + 2;
      const invA = invMass[k];
      const invB = invMass[k + 1];
      if (invA === 0 && invB === 0) continue;
      const spanX = pos[b] - pos[a];
      const spanY = pos[b + 1] - pos[a + 1];
      const spanSquared = spanX * spanX + spanY * spanY || 1;
      grid.range(
        Math.min(pos[a], pos[b]) - clearance, Math.min(pos[a + 1], pos[b + 1]) - clearance,
        Math.max(pos[a], pos[b]) + clearance, Math.max(pos[a + 1], pos[b + 1]) + clearance
      );
      for (let cy = grid.qy0; cy <= grid.qy1; cy++) {
        const base = cy * grid.cols;
        for (let cx = grid.qx0; cx <= grid.qx1; cx++) {
          const cell = base + cx;
          const end = counts[cell + 1];
          for (let slot = counts[cell]; slot < end; slot++) {
            const pin = items[slot];
            if (lab.pinWire[pin] === wire) continue;
            const pinX = lab.pinX[pin];
            const pinY = lab.pinY[pin];
            let t = ((pinX - pos[a]) * spanX + (pinY - pos[a + 1]) * spanY) / spanSquared;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            let nx = pos[a] + spanX * t - pinX;
            let ny = pos[a + 1] + spanY * t - pinY;
            const distanceSquared = nx * nx + ny * ny;
            if (distanceSquared >= limit) continue;
            let distance = Math.sqrt(distanceSquared);
            if (distance > 1e-4) {
              nx /= distance;
              ny /= distance;
            } else {
              // пин ровно на отрезке — уводим жгут в сторону по нормали к нему
              const span = Math.sqrt(spanSquared);
              nx = -spanY / span;
              ny = spanX / span;
              distance = 0;
            }
            // Распределение по концам через веса наименьших квадратов и жёсткий
            // потолок сдвига. Без потолка контакт у самого закреплённого конца
            // (t → 0 при неподвижном начале) требует от соседней точки сдвига
            // push/t и выстреливает жгутом через полсцены.
            const weightA = invA > 0 ? 1 - t : 0;
            const weightB = invB > 0 ? t : 0;
            const denominator = weightA * weightA + weightB * weightB;
            if (denominator <= 1e-8) continue;
            contacts++;
            // Флаг ставится по факту касания, а не по факту сдвига: скоростное
            // ограничение должно работать и внутри допуска, иначе точка внутри
            // slop свободно разгоняется в пин и вылетает обратно рывком.
            if (contactFlag) {
              if (weightA > 0) {
                contactFlag[k] = 1;
                contactNormal[a] = nx;
                contactNormal[a + 1] = ny;
              }
              if (weightB > 0) {
                contactFlag[k + 1] = 1;
                contactNormal[b] = nx;
                contactNormal[b + 1] = ny;
              }
            }
            const push = Math.max(0, clearance - distance - slop) * beta;
            if (push <= 0) continue;
            if (weightA > 0) {
              const step = Math.min(maxPush, push * weightA / denominator);
              pos[a] += nx * step;
              pos[a + 1] += ny * step;
              if (prev) {
                prev[a] += nx * step;
                prev[a + 1] += ny * step;
              }
            }
            if (weightB > 0) {
              const step = Math.min(maxPush, push * weightB / denominator);
              pos[b] += nx * step;
              pos[b + 1] += ny * step;
              if (prev) {
                prev[b] += nx * step;
                prev[b + 1] += ny * step;
              }
            }
          }
        }
      }
    }
  }
  return contacts;
}

// ---------------------------------------------------------------- замеры

class Meter {
  constructor(size = 90) {
    this.samples = new Float64Array(size);
    this.index = 0;
    this.filled = 0;
    this.scratch = new Float64Array(size);
  }

  push(value) {
    this.samples[this.index] = value;
    this.index = (this.index + 1) % this.samples.length;
    if (this.filled < this.samples.length) this.filled++;
  }

  quantile(q) {
    if (!this.filled) return 0;
    const view = this.scratch.subarray(0, this.filled);
    view.set(this.samples.subarray(0, this.filled));
    const sorted = Array.prototype.slice.call(view).sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  }
}

// ---------------------------------------------------------------- лаборатория

export function startLab(config) {
  const canvas = document.getElementById('stage');
  const context = canvas.getContext('2d', {alpha: false});
  const hud = document.getElementById('hud');
  const controlsHost = document.getElementById('controls');

  const lab = {
    solver: config.solver,
    wires: [],
    pinX: new Float64Array(0),
    pinY: new Float64Array(0),
    pinWire: new Int32Array(0),
    pinCount: 0,
    grid: new PinGrid(CELL * 2),
    params: {},
    drag: null,
    gravity: {x: 0, y: 0.22 * 60 * 60},   // px/с², эквивалент .22 px за кадр 60 Гц
    cell: CELL,
    wireWidth: WIRE_WIDTH,
    clearance: CLEARANCE,
    view: {x: 0, y: 0, zoom: 1},
    frame: 0,
    now: 0,
    extraStats: []
  };

  // -------------------------------------------------------------- контролы

  const params = config.controls || [];
  const controlRefs = [];
  controlsHost.innerHTML = '<h2>управление</h2>';
  for (const spec of params) {
    lab.params[spec.id] = spec.value;
    const block = document.createElement('div');
    block.className = 'ctl';
    if (spec.type === 'toggle') {
      const button = document.createElement('button');
      button.className = 'toggle';
      button.type = 'button';
      button.textContent = spec.label;
      button.setAttribute('aria-pressed', String(!!spec.value));
      button.onclick = () => {
        lab.params[spec.id] = !lab.params[spec.id];
        button.setAttribute('aria-pressed', String(lab.params[spec.id]));
        if (spec.rebuild) rebuild();
      };
      block.append(button);
    } else if (spec.type === 'chips') {
      const head = document.createElement('div');
      head.className = 'ctl-head';
      head.innerHTML = `<span>${spec.label}</span>`;
      const chips = document.createElement('div');
      chips.className = 'chips';
      for (const option of spec.options) {
        const chip = document.createElement('button');
        chip.className = 'chip';
        chip.type = 'button';
        chip.textContent = option.label;
        chip.setAttribute('aria-pressed', String(option.value === spec.value));
        chip.onclick = () => {
          lab.params[spec.id] = option.value;
          for (const sibling of chips.children) sibling.setAttribute('aria-pressed', 'false');
          chip.setAttribute('aria-pressed', 'true');
          if (spec.rebuild) rebuild();
        };
        chips.append(chip);
      }
      block.append(head, chips);
    } else {
      const head = document.createElement('div');
      head.className = 'ctl-head';
      const value = document.createElement('i');
      const format = spec.format || (v => String(v));
      value.textContent = format(spec.value);
      head.innerHTML = `<span>${spec.label}</span>`;
      head.append(value);
      const range = document.createElement('input');
      range.type = 'range';
      range.min = spec.min;
      range.max = spec.max;
      range.step = spec.step ?? 1;
      range.value = spec.value;
      range.oninput = () => {
        lab.params[spec.id] = Number(range.value);
        value.textContent = format(Number(range.value));
        if (spec.rebuild) rebuild();
      };
      block.append(head, range);
      controlRefs.push({spec, range, value});
    }
    controlsHost.append(block);
  }
  if (config.note) {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = config.note;
    controlsHost.append(note);
  }

  // -------------------------------------------------------------- сцена

  function rebuild() {
    lab.wires = makeScene(lab.params.count ?? config.count ?? 160, 11);
    const total = lab.wires.reduce((sum, wire) => sum + (wire.endX === undefined ? 1 : 2), 0);
    lab.pinX = new Float64Array(total);
    lab.pinY = new Float64Array(total);
    lab.pinWire = new Int32Array(total);
    lab.startPin = new Int32Array(lab.wires.length);
    lab.tailPin = new Int32Array(lab.wires.length).fill(-1);
    let cursor = 0;
    lab.wires.forEach((wire, index) => {
      lab.startPin[index] = cursor;
      lab.pinX[cursor] = (wire.x + 0.5) * CELL;
      lab.pinY[cursor] = (wire.y + 0.5) * CELL;
      lab.pinWire[cursor++] = index;
      if (wire.endX !== undefined) {
        lab.tailPin[index] = cursor;
        lab.pinX[cursor] = (wire.endX + 0.5) * CELL;
        lab.pinY[cursor] = (wire.endY + 0.5) * CELL;
        lab.pinWire[cursor++] = index;
      }
    });
    lab.pinCount = cursor;
    lab.drag = null;
    lab.solver.init(lab);
    fitPending = true;
  }

  let fitPending = true;

  function fitView() {
    if (!canvas.clientWidth || !canvas.clientHeight) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < lab.pinCount; i++) {
      minX = Math.min(minX, lab.pinX[i]);
      maxX = Math.max(maxX, lab.pinX[i]);
      minY = Math.min(minY, lab.pinY[i]);
      maxY = Math.max(maxY, lab.pinY[i]);
    }
    const pad = CELL * 5;
    const width = maxX - minX + pad * 2;
    const height = maxY - minY + pad * 2 + CELL * 12;
    const zoom = Math.min(canvas.clientWidth / width, canvas.clientHeight / height, 1.1);
    lab.view.zoom = zoom;
    lab.view.x = canvas.clientWidth / 2 - (minX + maxX) / 2 * zoom;
    lab.view.y = canvas.clientHeight / 2 - (minY + maxY + CELL * 8) / 2 * zoom;
  }

  // -------------------------------------------------------------- ввод

  const toWorld = event => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left - lab.view.x) / lab.view.zoom,
      y: (event.clientY - rect.top - lab.view.y) / lab.view.zoom
    };
  };

  let pan = null;
  canvas.addEventListener('pointerdown', event => {
    canvas.setPointerCapture(event.pointerId);
    const point = toWorld(event);
    let best = -1;
    let bestDistance = CELL * 1.4;
    for (let i = 0; i < lab.wires.length; i++) {
      const pin = lab.startPin[i];
      const distance = Math.hypot(lab.pinX[pin] - point.x, lab.pinY[pin] - point.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    if (best >= 0) {
      lab.drag = {wire: best, x: point.x, y: point.y};
      canvas.classList.add('grabbing');
    } else {
      pan = {x: event.clientX, y: event.clientY, viewX: lab.view.x, viewY: lab.view.y};
      canvas.classList.add('grabbing');
    }
  });

  canvas.addEventListener('pointermove', event => {
    if (lab.drag) {
      const point = toWorld(event);
      const wire = lab.wires[lab.drag.wire];
      const tail = lab.tailPin[lab.drag.wire];
      // У жгута с закреплённым хвостом начало нельзя утащить дальше его длины —
      // тот же предел, что держит `tailMinimumLength` в редакторе.
      if (tail >= 0) {
        const dx = point.x - lab.pinX[tail];
        const dy = point.y - lab.pinY[tail];
        const reach = wire.length * CELL;
        const distance = Math.hypot(dx, dy);
        if (distance > reach) {
          point.x = lab.pinX[tail] + dx / distance * reach;
          point.y = lab.pinY[tail] + dy / distance * reach;
        }
      }
      lab.drag.x = point.x;
      lab.drag.y = point.y;
      lab.pinX[lab.startPin[lab.drag.wire]] = point.x;
      lab.pinY[lab.startPin[lab.drag.wire]] = point.y;
    } else if (pan) {
      lab.view.x = pan.viewX + (event.clientX - pan.x);
      lab.view.y = pan.viewY + (event.clientY - pan.y);
    }
  });

  const release = () => {
    if (lab.drag) {
      const wire = lab.wires[lab.drag.wire];
      const pin = lab.startPin[lab.drag.wire];
      wire.x = Math.round(lab.pinX[pin] / CELL - 0.5);
      wire.y = Math.round(lab.pinY[pin] / CELL - 0.5);
      lab.pinX[pin] = (wire.x + 0.5) * CELL;
      lab.pinY[pin] = (wire.y + 0.5) * CELL;
      lab.drag = null;
    }
    pan = null;
    canvas.classList.remove('grabbing');
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    const before = {x: (sx - lab.view.x) / lab.view.zoom, y: (sy - lab.view.y) / lab.view.zoom};
    const factor = Math.exp(-event.deltaY * 0.0015);
    lab.view.zoom = Math.max(0.06, Math.min(3, lab.view.zoom * factor));
    lab.view.x = sx - before.x * lab.view.zoom;
    lab.view.y = sy - before.y * lab.view.zoom;
  }, {passive: false});

  // -------------------------------------------------------------- рендер

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    lab.dpr = dpr;
  }
  window.addEventListener('resize', resize);

  // Полилиния жгута из плоского буфера [x0,y0,x1,y1,...] начиная с точки `start`.
  // Та же толщина и то же квадратичное сглаживание, что у SVG-редактора.
  lab.strokeWire = (points, start, count, color) => {
    if (count < 2) return;
    const base = start * 2;
    context.strokeStyle = color;
    context.beginPath();
    context.moveTo(points[base], points[base + 1]);
    for (let i = 1; i < count - 1; i++) {
      const at = base + i * 2;
      context.quadraticCurveTo(points[at], points[at + 1], (points[at] + points[at + 2]) / 2, (points[at + 1] + points[at + 3]) / 2);
    }
    context.lineTo(points[base + (count - 1) * 2], points[base + (count - 1) * 2 + 1]);
    context.stroke();
  };

  function drawGrid() {
    const {zoom, x, y} = lab.view;
    const step = CELL * zoom;
    if (step < 7) return;
    context.strokeStyle = 'rgba(255,255,255,.22)';
    context.lineWidth = 1;
    context.beginPath();
    const startX = x % step;
    const startY = y % step;
    for (let px = startX; px < canvas.clientWidth; px += step) {
      context.moveTo(px + 0.5, 0);
      context.lineTo(px + 0.5, canvas.clientHeight);
    }
    for (let py = startY; py < canvas.clientHeight; py += step) {
      context.moveTo(0, py + 0.5);
      context.lineTo(canvas.clientWidth, py + 0.5);
    }
    context.stroke();
  }

  function drawPins() {
    context.fillStyle = '#f8f5ed';
    for (let i = 0; i < lab.pinCount; i++) {
      context.beginPath();
      context.arc(lab.pinX[i], lab.pinY[i], PIN_RADIUS, 0, Math.PI * 2);
      context.fill();
    }
  }

  // -------------------------------------------------------------- цикл

  const simMeter = new Meter();
  const drawMeter = new Meter();
  const frameMeter = new Meter();
  let previous = performance.now();
  let hudAt = 0;

  function loop(now) {
    requestAnimationFrame(loop);
    const raw = (now - previous) / 1000;
    previous = now;
    const dt = Math.min(1 / 30, Math.max(1 / 240, raw || 1 / 60));
    // Пропуски больше 200 мс — это throttling вкладки, а не цена кадра.
    if (raw < 0.2) frameMeter.push(raw * 1000);
    lab.now = now / 1000;
    lab.frame++;
    resizeIfNeeded();
    if (fitPending && canvas.clientWidth) {
      fitView();
      fitPending = false;
    }

    const simStart = performance.now();
    lab.grid.build(lab.pinX, lab.pinY, lab.pinCount);
    lab.solver.step(dt, lab);
    simMeter.push(performance.now() - simStart);

    const drawStart = performance.now();
    context.setTransform(lab.dpr, 0, 0, lab.dpr, 0, 0);
    context.fillStyle = BG;
    context.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    drawGrid();
    context.save();
    context.translate(lab.view.x, lab.view.y);
    context.scale(lab.view.zoom, lab.view.zoom);
    context.lineWidth = WIRE_WIDTH;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    if (lab.solver.drawBelow) lab.solver.drawBelow(context, lab);
    lab.solver.draw(context, lab);
    drawPins();
    context.restore();
    drawMeter.push(performance.now() - drawStart);

    if (now - hudAt > 180) {
      hudAt = now;
      renderHud();
    }
  }

  let lastWidth = 0;
  let lastHeight = 0;
  function resizeIfNeeded() {
    if (canvas.clientWidth !== lastWidth || canvas.clientHeight !== lastHeight) {
      lastWidth = canvas.clientWidth;
      lastHeight = canvas.clientHeight;
      resize();
    }
  }

  function renderHud() {
    const rows = [
      ['жгутов', String(lab.wires.length)],
      ['точек', String(lab.solver.particleCount ? lab.solver.particleCount(lab) : '—')],
      ['пинов', String(lab.pinCount)],
      null,
      ['физика p50', simMeter.quantile(0.5).toFixed(2) + ' мс'],
      ['физика p95', simMeter.quantile(0.95).toFixed(2) + ' мс', simMeter.quantile(0.95) > 8],
      ['рендер p50', drawMeter.quantile(0.5).toFixed(2) + ' мс'],
      ['кадр p50', frameMeter.filled ? frameMeter.quantile(0.5).toFixed(1) + ' мс' : '—'],
      ['fps', frameMeter.filled ? (1000 / frameMeter.quantile(0.5)).toFixed(0) : '—']
    ];
    const extra = lab.solver.stats ? lab.solver.stats(lab) : [];
    if (extra.length) rows.push(null, ...extra);
    hud.innerHTML = '<h2>телеметрия</h2>' + rows.map(row => {
      if (!row) return '<hr class="sep">';
      return `<div class="row${row[2] ? ' hot' : ''}"><span>${row[0]}</span><b>${row[1]}</b></div>`;
    }).join('');
  }

  resize();
  resizeIfNeeded();
  rebuild();
  requestAnimationFrame(loop);
  window.lab = lab;  // консоль браузера — часть инструментария демо
  return lab;
}
