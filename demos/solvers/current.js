// Солвер редактора как есть: тот же цикл, что в `tick()` index.html, и тот же
// `src/collision.js`. Нужен для сравнения «сейчас» с альтернативами на одной сцене.
import {CELL, createChains} from '../lab.js';
import {buildPinSpatialIndex, collectSegmentCandidates, resolveWirePinCollisions} from '../../src/collision.js';

export function createCurrentSolver() {
  return {
    wires: [],
    prevPositions: null,

    init(lab) {
      const chains = createChains(lab);
      this.wires = lab.wires.map((wire, index) => {
        const points = [];
        for (let k = chains.offset[index]; k < chains.offset[index + 1]; k++) {
          const x = chains.pos[k * 2];
          const y = chains.pos[k * 2 + 1];
          points.push({x, y, ox: x, oy: y});
        }
        return {points, step: chains.rest[index], pinned: lab.tailPin[index] >= 0};
      });
      this.prevPositions = null;
    },

    // Индекс пинов в клетках, как его собирает редактор во время драга:
    // каждый кадр заново и с прошлыми позициями, чтобы ловить пролёт пина.
    buildIndex(lab) {
      // Порядок пинов в индексе → номер пина сцены: по нему полигон отпускает пары.
      this.pinOfOrder = [];
      const source = lab.wires.map((wire, index) => {
        const start = lab.startPin[index];
        const tail = lab.tailPin[index];
        this.pinOfOrder.push(start);
        if (tail >= 0) this.pinOfOrder.push(tail);
        const entry = {id: 'w' + index, x: lab.pinX[start] / CELL - 0.5, y: lab.pinY[start] / CELL - 0.5, length: wire.length};
        if (tail >= 0) {
          entry.endX = lab.pinX[tail] / CELL - 0.5;
          entry.endY = lab.pinY[tail] / CELL - 0.5;
        }
        return entry;
      });
      for (let pin = 0; pin < lab.pinCount; pin++) {
        if (lab.pinWire[pin] >= 0) continue;
        this.pinOfOrder.push(pin);
        source.push({id: 'p' + pin, x: lab.pinX[pin] / CELL - 0.5, y: lab.pinY[pin] / CELL - 0.5, length: 0});
      }
      const index = buildPinSpatialIndex(source, CELL, this.prevPositions);
      this.prevPositions = index.positions;
      return index;
    },

    step(dt, lab) {
      const index = this.buildIndex(lab);
      const gravityX = lab.gravity.x * dt * dt;
      const gravityY = lab.gravity.y * dt * dt;
      const clearance = CELL * 1.06;
      const slop = CELL * 0.04;
      const collisions = lab.params.collisions !== false;
      const damping = collisions ? 0.78 : 0.94;

      this.wires.forEach((wire, w) => {
        const p = wire.points;
        const last = p.length - 1;
        const ax = lab.pinX[lab.startPin[w]];
        const ay = lab.pinY[lab.startPin[w]];
        const tail = lab.tailPin[w];
        const ex = tail >= 0 ? lab.pinX[tail] : 0;
        const ey = tail >= 0 ? lab.pinY[tail] : 0;
        const pinned = wire.pinned;
        p[0].x = p[0].ox = ax;
        p[0].y = p[0].oy = ay;
        if (pinned) {
          p[last].x = p[last].ox = ex;
          p[last].y = p[last].oy = ey;
        }
        for (let i = 1; i < p.length; i++) {
          if (pinned && i === last) continue;
          const q = p[i];
          const vx = (q.x - q.ox) * damping;
          const vy = (q.y - q.oy) * damping;
          q.ox = q.x;
          q.oy = q.y;
          q.x += vx + gravityX;
          q.y += vy + gravityY;
        }
        const id = 'w' + w;
        let candidates = collisions ? collectSegmentCandidates(index, p, clearance + CELL, id) : null;
        const ghosts = lab.ghostPins?.[w];
        if (candidates && ghosts?.size) candidates = candidates.map(list => list.filter(pin => !ghosts.has(this.pinOfOrder[pin.order])));
        for (let n = 0; n < 10; n++) {
          p[0].x = ax;
          p[0].y = ay;
          if (pinned) {
            p[last].x = ex;
            p[last].y = ey;
          }
          for (let i = 0; i < last; i++) {
            const a = p[i];
            const b = p[i + 1];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const diff = (dist - wire.step) / dist;
            const fixedA = i === 0;
            const fixedB = pinned && i + 1 === last;
            if (fixedA && fixedB) continue;
            if (fixedA) {
              b.x -= dx * diff;
              b.y -= dy * diff;
            } else if (fixedB) {
              a.x += dx * diff;
              a.y += dy * diff;
            } else {
              a.x += dx * diff * 0.5;
              a.y += dy * diff * 0.5;
              b.x -= dx * diff * 0.5;
              b.y -= dy * diff * 0.5;
            }
          }
          if (collisions) {
            resolveWirePinCollisions(id, p, pinned, index, clearance, {
              correction: 0.35, maxPush: CELL * 0.5, candidates, response: 'position', slop
            });
          }
        }
        if (collisions) {
          for (let n = 0; n < 2; n++) {
            resolveWirePinCollisions(id, p, pinned, index, clearance, {
              correction: 0.65, maxPush: CELL * 0.35, candidates, slop
            });
          }
        }
        if (pinned) {
          p[last].x = p[last].ox = ex;
          p[last].y = p[last].oy = ey;
        }
      });
    },

    // Новая длина в клетках. Число точек — формула редактора; при его смене
    // цепочка пересэмплируется вдоль текущей формы, как `resampleRuntime()`.
    setLength(lab, w, length) {
      const wire = this.wires[w];
      lab.wires[w].length = length;
      // 64 — предел редактора; полигон может поднять его, чтобы длинный шнур не грубел
      const count = Math.max(4, Math.min(lab.params.maxPoints ?? 64, Math.ceil(length * 1.35)));
      wire.step = length * CELL / (count - 1);
      const p = wire.points;
      if (p.length === count) return;
      const lengths = [0];
      for (let i = 1; i < p.length; i++) lengths.push(lengths[i - 1] + Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y));
      const total = lengths[lengths.length - 1];
      const next = [];
      let seg = 1;
      for (let i = 0; i < count; i++) {
        const target = total * i / (count - 1);
        while (seg < lengths.length - 1 && lengths[seg] < target) seg++;
        const t = Math.max(0, Math.min(1, (target - lengths[seg - 1]) / (lengths[seg] - lengths[seg - 1] || 1)));
        const x = p[seg - 1].x + (p[seg].x - p[seg - 1].x) * t;
        const y = p[seg - 1].y + (p[seg].y - p[seg - 1].y) * t;
        next.push({x, y, ox: x, oy: y});
      }
      wire.points = next;
    },

    polyline(w) {
      const points = this.wires[w].points;
      const flat = new Float32Array(points.length * 2);
      points.forEach((point, i) => {
        flat[i * 2] = point.x;
        flat[i * 2 + 1] = point.y;
      });
      return flat;
    },

    draw(context, lab) {
      this.wires.forEach((wire, w) => lab.strokeWire(this.polyline(w), 0, wire.points.length, lab.wires[w].color));
    }
  };
}
