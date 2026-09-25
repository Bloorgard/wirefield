import {CELL} from '../lab.js';

const MAX_WRAPS = 10;
const SAG_SAMPLES = 10;
const cross = (ax, ay, bx, by) => ax * by - ay * bx;

export function createTautSolver() {
  return {
    ropes: [],
    buffer: new Float32Array(0),
    wraps: 0,
    events: 0,

    init(lab) {
      this.ropes = lab.wires.map((wire, index) => {
        const anchorX = lab.pinX[lab.startPin[index]];
        const anchorY = lab.pinY[lab.startPin[index]];
        const tail = lab.tailPin[index];
        return {
          rope: wire.length * CELL,
          pinned: tail >= 0,
          wraps: [],
          anchorX,
          anchorY,
          tipX: tail >= 0 ? lab.pinX[tail] : anchorX,
          tipY: tail >= 0 ? lab.pinY[tail] : anchorY + wire.length * CELL,
          velX: 0,
          velY: 0
        };
      });
      this.buffer = new Float32Array((MAX_WRAPS + 2) * SAG_SAMPLES * 2 + 8);
      this.pinPrevX = Float64Array.from(lab.pinX);
      this.pinPrevY = Float64Array.from(lab.pinY);
    },

    particleCount() {
      return this.ropes.reduce((sum, rope) => sum + rope.wraps.length + 2, 0);
    },

    // Точка перед зацепом i: предыдущий зацеп либо якорь.
    before(rope, index, lab) {
      if (index > 0) {
        const pin = rope.wraps[index - 1].pin;
        return [lab.pinX[pin], lab.pinY[pin]];
      }
      return [rope.anchorX, rope.anchorY];
    },

    after(rope, index, lab) {
      if (index + 1 < rope.wraps.length) {
        const pin = rope.wraps[index + 1].pin;
        return [lab.pinX[pin], lab.pinY[pin]];
      }
      return [rope.tipX, rope.tipY];
    },

    // Длина уже израсходованной части: якорь → зацепы.
    usedLength(rope, lab) {
      let length = 0;
      let x = rope.anchorX;
      let y = rope.anchorY;
      for (const wrap of rope.wraps) {
        length += Math.hypot(lab.pinX[wrap.pin] - x, lab.pinY[wrap.pin] - y);
        x = lab.pinX[wrap.pin];
        y = lab.pinY[wrap.pin];
      }
      return length;
    },

    // Соскальзывание: если якорь уехал так, что пути по зацепам стало не хватать
    // длины, нить срывается с ближайшего к свободному концу зацепа. Без этого
    // правила путь молча становится длиннее нити, и жгут начинает растягиваться.
    slip(rope, lab) {
      while (rope.wraps.length) {
        const last = rope.wraps[rope.wraps.length - 1];
        let total = this.usedLength(rope, lab);
        if (rope.pinned) total += Math.hypot(rope.tipX - lab.pinX[last.pin], rope.tipY - lab.pinY[last.pin]);
        if (total <= rope.rope - CELL * 0.25) break;
        rope.wraps.pop();
        this.events++;
      }
    },

    // Разматывание: нить сошла с зацепа, когда поворот на нём выпрямился и пошёл
    // в другую сторону. Порог нужен как гистерезис — иначе зацеп, поставленный по
    // касательной, снимается тем же кадром, и счётчик событий не успокаивается.
    unwind(rope, lab) {
      for (let index = rope.wraps.length - 1; index >= 0; index--) {
        const wrap = rope.wraps[index];
        const [px, py] = this.before(rope, index, lab);
        const [nx, ny] = this.after(rope, index, lab);
        const wx = lab.pinX[wrap.pin];
        const wy = lab.pinY[wrap.pin];
        const inX = wx - px;
        const inY = wy - py;
        const outX = nx - wx;
        const outY = ny - wy;
        const scale = Math.hypot(inX, inY) * Math.hypot(outX, outY);
        if (scale < 1e-6) continue;
        const turn = cross(inX, inY, outX, outY) / scale;
        if (turn * wrap.side < -0.03) {
          rope.wraps.splice(index, 1);
          this.events++;
        }
      }
    },

    // Наматывание: пин, который отрезок пересёк за кадр (заметённый треугольник)
    // либо задел ближе зазора. Событие дискретное, промахнуться между кадрами
    // нельзя — именно поэтому здесь нет туннелирования в принципе.
    wind(rope, lab, fromX, fromY, oldX, oldY, newX, newY, reach) {
      if (rope.wraps.length >= MAX_WRAPS) return;
      const grid = lab.grid;
      const clearance = lab.clearance;
      const minX = Math.min(fromX, oldX, newX) - clearance;
      const maxX = Math.max(fromX, oldX, newX) + clearance;
      const minY = Math.min(fromY, oldY, newY) - clearance;
      const maxY = Math.max(fromY, oldY, newY) + clearance;
      grid.range(minX, minY, maxX, maxY);
      let best = -1;
      let bestAngle = Infinity;
      const baseX = oldX - fromX;
      const baseY = oldY - fromY;
      const spanX = newX - fromX;
      const spanY = newY - fromY;
      const spanSquared = spanX * spanX + spanY * spanY || 1;

      for (let cy = grid.qy0; cy <= grid.qy1; cy++) {
        const base = cy * grid.cols;
        for (let cx = grid.qx0; cx <= grid.qx1; cx++) {
          const cell = base + cx;
          const end = grid.counts[cell + 1];
          for (let slot = grid.counts[cell]; slot < end; slot++) {
            const pin = grid.items[slot];
            if (lab.pinWire[pin] === rope.index) continue;
            if (rope.wraps.some(wrap => wrap.pin === pin)) continue;
            const px = lab.pinX[pin] - fromX;
            const py = lab.pinY[pin] - fromY;
            const distance = Math.hypot(px, py);
            if (distance < 1e-3 || distance > reach) continue;

            const sweep = cross(baseX, baseY, px, py) * cross(px, py, spanX, spanY) > 0
              && cross(baseX, baseY, spanX, spanY) * cross(baseX, baseY, px, py) > 0;
            let touch = false;
            if (!sweep) {
              let t = ((lab.pinX[pin] - fromX) * spanX + (lab.pinY[pin] - fromY) * spanY) / spanSquared;
              if (t > 0.05 && t < 0.95) {
                const nearX = fromX + spanX * t - lab.pinX[pin];
                const nearY = fromY + spanY * t - lab.pinY[pin];
                touch = nearX * nearX + nearY * nearY < clearance * clearance;
              }
            }
            if (!sweep && !touch) continue;
            const angle = Math.abs(Math.atan2(cross(baseX, baseY, px, py), baseX * px + baseY * py));
            if (angle < bestAngle) {
              bestAngle = angle;
              best = pin;
            }
          }
        }
      }
      if (best < 0) return;
      // Сторону берём от хорды, а не от угла на зацепе: у касательного зацепа
      // угол около нуля и его знак — подбрасывание монеты.
      const chord = cross(spanX, spanY, lab.pinX[best] - fromX, lab.pinY[best] - fromY);
      rope.wraps.push({pin: best, side: chord >= 0 ? -1 : 1});
      this.events++;
    },

    // Наматывание на чужой пин, который сам пересёк пролёт нити. Без этого нить
    // видит только движение своих концов, и пин, который тащат сквозь неё,
    // проходит насквозь. Пролёт и путь пина — два отрезка: пересеклись — зацеп.
    windMovingPins(rope, lab) {
      for (let pin = 0; pin < lab.pinCount; pin++) {
        if (lab.pinWire[pin] === rope.index || rope.wraps.length >= MAX_WRAPS) continue;
        const fromX = this.pinPrevX[pin];
        const fromY = this.pinPrevY[pin];
        const toX = lab.pinX[pin];
        const toY = lab.pinY[pin];
        if (fromX === toX && fromY === toY) continue;
        if (rope.wraps.some(wrap => wrap.pin === pin)) continue;
        for (let span = 0; span <= rope.wraps.length; span++) {
          const [ax, ay] = this.before(rope, span, lab);
          const [bx, by] = span < rope.wraps.length
            ? [lab.pinX[rope.wraps[span].pin], lab.pinY[rope.wraps[span].pin]]
            : [rope.tipX, rope.tipY];
          const spanX = bx - ax;
          const spanY = by - ay;
          const sideFrom = cross(spanX, spanY, fromX - ax, fromY - ay);
          const sideTo = cross(spanX, spanY, toX - ax, toY - ay);
          const pathX = toX - fromX;
          const pathY = toY - fromY;
          const onPathA = cross(pathX, pathY, ax - fromX, ay - fromY);
          const onPathB = cross(pathX, pathY, bx - fromX, by - fromY);
          if (sideFrom * sideTo >= 0 || onPathA * onPathB >= 0) continue;
          rope.wraps.splice(span, 0, {pin, side: sideTo >= 0 ? -1 : 1});
          this.events++;
          break;
        }
      }
    },

    step(dt, lab) {
      const drag = lab.params.drag;
      const bounce = lab.params.bounce;
      const angle = lab.params.tilt * Math.PI / 180;
      lab.gravity.x = Math.sin(angle) * 792;
      lab.gravity.y = Math.cos(angle) * 792;
      this.events = 0;
      this.wraps = 0;

      for (let index = 0; index < this.ropes.length; index++) {
        const rope = this.ropes[index];
        rope.index = index;
        const anchorX = lab.pinX[lab.startPin[index]];
        const anchorY = lab.pinY[lab.startPin[index]];
        const movedX = rope.anchorX;
        const movedY = rope.anchorY;
        rope.anchorX = anchorX;
        rope.anchorY = anchorY;

        // Якорь поехал — первый пролёт мог намотаться на новый пин.
        if (movedX !== anchorX || movedY !== anchorY) {
          const [nextX, nextY] = rope.wraps.length
            ? [lab.pinX[rope.wraps[0].pin], lab.pinY[rope.wraps[0].pin]]
            : [rope.tipX, rope.tipY];
          this.wind(rope, lab, nextX, nextY, movedX, movedY, anchorX, anchorY, rope.rope);
        }
        this.windMovingPins(rope, lab);

        if (rope.pinned) {
          const pin = lab.tailPin[index];
          rope.tipX = lab.pinX[pin];
          rope.tipY = lab.pinY[pin];
          this.slip(rope, lab);
        } else {
          rope.velX += lab.gravity.x * dt;
          rope.velY += lab.gravity.y * dt;
          const decay = Math.max(0, 1 - drag * dt);
          rope.velX *= decay;
          rope.velY *= decay;
          const oldX = rope.tipX;
          const oldY = rope.tipY;
          rope.tipX += rope.velX * dt;
          rope.tipY += rope.velY * dt;

          let used = this.usedLength(rope, lab);
          let remaining = Math.max(CELL * 0.25, rope.rope - used);
          let last = rope.wraps.length - 1;
          this.wind(rope, lab,
            last >= 0 ? lab.pinX[rope.wraps[last].pin] : rope.anchorX,
            last >= 0 ? lab.pinY[rope.wraps[last].pin] : rope.anchorY,
            oldX, oldY, rope.tipX, rope.tipY, remaining);

          // Зацеп мог добавиться — точка вращения и остаток нити пересчитываются
          // до натяжения, иначе кончик сядет на окружность вокруг старого зацепа
          // и тут же уйдёт на другую сторону нового.
          this.slip(rope, lab);
          used = this.usedLength(rope, lab);
          remaining = Math.max(CELL * 0.25, rope.rope - used);
          last = rope.wraps.length - 1;
          const pivotX = last >= 0 ? lab.pinX[rope.wraps[last].pin] : rope.anchorX;
          const pivotY = last >= 0 ? lab.pinY[rope.wraps[last].pin] : rope.anchorY;

          // Натяжение: кончик садится на окружность радиуса «остаток нити».
          const dx = rope.tipX - pivotX;
          const dy = rope.tipY - pivotY;
          const distance = Math.hypot(dx, dy);
          if (distance > remaining && distance > 1e-6) {
            const nx = dx / distance;
            const ny = dy / distance;
            rope.tipX = pivotX + nx * remaining;
            rope.tipY = pivotY + ny * remaining;
            const radial = rope.velX * nx + rope.velY * ny;
            if (radial > 0) {
              rope.velX -= nx * radial * (1 + bounce);
              rope.velY -= ny * radial * (1 + bounce);
            }
          }
          this.pushTipOffPins(rope, lab);
        }

        this.unwind(rope, lab);
        this.wraps += rope.wraps.length;
      }
      this.pinPrevX.set(lab.pinX);
      this.pinPrevY.set(lab.pinY);
    },

    pushTipOffPins(rope, lab) {
      const grid = lab.grid;
      const clearance = lab.clearance;
      grid.range(rope.tipX - clearance, rope.tipY - clearance, rope.tipX + clearance, rope.tipY + clearance);
      for (let cy = grid.qy0; cy <= grid.qy1; cy++) {
        const base = cy * grid.cols;
        for (let cx = grid.qx0; cx <= grid.qx1; cx++) {
          const cell = base + cx;
          const end = grid.counts[cell + 1];
          for (let slot = grid.counts[cell]; slot < end; slot++) {
            const pin = grid.items[slot];
            if (lab.pinWire[pin] === rope.index) continue;
            const dx = rope.tipX - lab.pinX[pin];
            const dy = rope.tipY - lab.pinY[pin];
            const distance = Math.hypot(dx, dy);
            if (distance >= clearance || distance < 1e-6) continue;
            rope.tipX = lab.pinX[pin] + dx / distance * clearance;
            rope.tipY = lab.pinY[pin] + dy / distance * clearance;
            const normal = rope.velX * dx / distance + rope.velY * dy / distance;
            if (normal < 0) {
              rope.velX -= dx / distance * normal;
              rope.velY -= dy / distance * normal;
            }
          }
        }
      }
    },

    draw(context, lab) {
      const radius = lab.cell / 2;
      for (let index = 0; index < this.ropes.length; index++) {
        const rope = this.ropes[index];
        // узлы пути: якорь → зацепы (отодвинутые на радиус пина) → кончик
        const nodes = [[rope.anchorX, rope.anchorY]];
        for (let w = 0; w < rope.wraps.length; w++) {
          const pin = rope.wraps[w].pin;
          const [px, py] = this.before(rope, w, lab);
          const [nx, ny] = this.after(rope, w, lab);
          const wx = lab.pinX[pin];
          const wy = lab.pinY[pin];
          let ax = px - wx;
          let ay = py - wy;
          let bx = nx - wx;
          let by = ny - wy;
          const la = Math.hypot(ax, ay) || 1;
          const lb = Math.hypot(bx, by) || 1;
          ax /= la;
          ay /= la;
          bx /= lb;
          by /= lb;
          const mx = ax + bx;
          const my = ay + by;
          const m = Math.hypot(mx, my);
          if (m < 1e-3) nodes.push([wx, wy]);
          else nodes.push([wx - mx / m * radius, wy - my / m * radius]);
        }
        nodes.push([rope.tipX, rope.tipY]);

        // слабина раскладывается по пролётам и рисуется параболой
        let path = 0;
        for (let n = 1; n < nodes.length; n++) path += Math.hypot(nodes[n][0] - nodes[n - 1][0], nodes[n][1] - nodes[n - 1][1]);
        const slack = Math.max(0, rope.rope - path);
        const gravityLength = Math.hypot(lab.gravity.x, lab.gravity.y) || 1;
        const downX = lab.gravity.x / gravityLength;
        const downY = lab.gravity.y / gravityLength;

        let count = 0;
        const buffer = this.buffer;
        buffer[count++] = nodes[0][0];
        buffer[count++] = nodes[0][1];
        for (let n = 1; n < nodes.length; n++) {
          const ax = nodes[n - 1][0];
          const ay = nodes[n - 1][1];
          const bx = nodes[n][0];
          const by = nodes[n][1];
          const chord = Math.hypot(bx - ax, by - ay);
          const share = path > 1e-6 ? slack * chord / path : 0;
          const depth = share > 0.5 ? Math.sqrt(3 * chord * share / 8) : 0;
          if (depth < 1) {
            buffer[count++] = bx;
            buffer[count++] = by;
            continue;
          }
          for (let s = 1; s <= SAG_SAMPLES; s++) {
            const t = s / SAG_SAMPLES;
            const bulge = 4 * t * (1 - t) * depth;
            buffer[count++] = ax + (bx - ax) * t + downX * bulge;
            buffer[count++] = ay + (by - ay) * t + downY * bulge;
          }
        }
        lab.strokeWire(buffer, 0, count / 2, lab.wires[index].color);
      }
    },

    stats(lab) {
      return [
        ['зацепов', String(this.wraps)],
        ['событий за кадр', String(this.events)],
        ['узлов пути', String(this.particleCount(lab))],
        ['растяжение', 'нет']
      ];
    }
  };
}
