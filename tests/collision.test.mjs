import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPinSpatialIndex, collectSegmentCandidates, pinClusters, prepareRopeContacts, querySegmentPins, resolveRopeContacts, resolveWirePinCollisions, settleRopeContacts} from '../src/collision.js';

const cell = 44;
const wires = [
  {id: 'A', x: 0, y: 0, length: 4, color: '#102cff'},
  {id: 'B', x: 2, y: 0, length: 2, color: '#f200e9'},
  {id: 'C', x: 20, y: 20, length: 2, color: '#f200e9', endX: 21, endY: 20}
];

test('spatial index keeps pin order and excludes the active wire', () => {
  const index = buildPinSpatialIndex(wires, cell);
  assert.equal(index.pinCount, 4);
  const pins = querySegmentPins(index, {x: 22, y: 22}, {x: 132, y: 22}, cell, 'A');
  assert.deepEqual(pins.map(pin => pin.id), ['B']);
});

test('spatial collision solver deflects a free segment around a foreign pin', () => {
  const index = buildPinSpatialIndex(wires, cell);
  const points = [
    {x: 22, y: 22, ox: 22, oy: 22},
    {x: 110, y: 22, ox: 110, oy: 22},
    {x: 154, y: 22, ox: 154, oy: 22}
  ];
  const contacts = resolveWirePinCollisions('A', points, false, index, cell * 0.98);
  assert.ok(contacts > 0);
  assert.notEqual(points[1].y, 22);
});

test('collectSegmentCandidates returns one deterministic list per segment', () => {
  const index = buildPinSpatialIndex(wires, cell);
  const points = [
    {x: 22, y: 22, ox: 22, oy: 22},
    {x: 110, y: 22, ox: 110, oy: 22},
    {x: 154, y: 22, ox: 154, oy: 22}
  ];
  const lists = collectSegmentCandidates(index, points, cell, 'A');
  assert.equal(lists.length, 2);
  for (let segment = 0; segment < 2; segment++) {
    const direct = querySegmentPins(index, points[segment], points[segment + 1], cell, 'A');
    assert.deepEqual(lists[segment].map(pin => pin.id), direct.map(pin => pin.id));
  }
});

test('resolveWirePinCollisions with prebuilt candidates matches direct queries', () => {
  const index = buildPinSpatialIndex(wires, cell);
  const makePoints = () => [
    {x: 22, y: 22, ox: 22, oy: 22},
    {x: 110, y: 22, ox: 110, oy: 22},
    {x: 154, y: 22, ox: 154, oy: 22}
  ];
  const direct = makePoints();
  const cached = makePoints();
  const clearance = cell * 0.98;
  const directContacts = resolveWirePinCollisions('A', direct, false, index, clearance);
  const candidates = collectSegmentCandidates(index, cached, clearance, 'A');
  const cachedContacts = resolveWirePinCollisions('A', cached, false, index, clearance, {candidates});
  assert.equal(cachedContacts, directContacts);
  for (let i = 0; i < direct.length; i++) {
    assert.equal(cached[i].x, direct[i].x);
    assert.equal(cached[i].y, direct[i].y);
  }
});

test('position response pushes points without changing their velocity', () => {
  const index = buildPinSpatialIndex(wires, cell);
  const points = [
    {x: 22, y: 22, ox: 22, oy: 22},
    {x: 110, y: 22, ox: 110, oy: 19},
    {x: 154, y: 22, ox: 154, oy: 22}
  ];
  const before = points.map(p => ({vx: p.x - p.ox, vy: p.y - p.oy}));
  const contacts = resolveWirePinCollisions('A', points, false, index, cell * 0.98, {response: 'position'});
  assert.ok(contacts > 0);
  assert.notEqual(points[1].y, 22);
  for (let i = 0; i < points.length; i++) {
    assert.ok(Math.abs(points[i].x - points[i].ox - before[i].vx) < 1e-9);
    assert.ok(Math.abs(points[i].y - points[i].oy - before[i].vy) < 1e-9);
  }
});

test('segment that crossed a pin between steps is pushed back to its previous side', () => {
  const index = buildPinSpatialIndex(wires, cell);
  const points = [
    {x: 22, y: 22, ox: 22, oy: 22},
    {x: 110, y: 30, ox: 110, oy: -40},
    {x: 198, y: 22, ox: 198, oy: 22}
  ];
  const contacts = resolveWirePinCollisions('A', points, false, index, cell * 0.98);
  assert.ok(contacts > 0);
  assert.ok(points[1].y < 22, `expected the point back above the pin, got y=${points[1].y}`);
});

test('deep crossing recovers fully within one frame of app-style passes', () => {
  const index = buildPinSpatialIndex(wires, cell);
  const clearance = cell * 1.06;
  const points = [
    {x: 22, y: -100, ox: 22, oy: -100},
    {x: 110, y: 52, ox: 110, oy: -30},
    {x: 198, y: -100, ox: 198, oy: -100}
  ];
  for (let n = 0; n < 10; n++) {
    resolveWirePinCollisions('A', points, false, index, clearance, {correction: .35, maxPush: cell * .5, response: 'position'});
  }
  for (let n = 0; n < 2; n++) {
    resolveWirePinCollisions('A', points, false, index, clearance, {correction: .65, maxPush: cell * .35});
  }
  const pinY = 22;
  assert.ok(points[1].y < pinY, `expected the point back above the pin after one frame, got y=${points[1].y}`);
  assert.ok(pinY - points[1].y >= clearance * 0.5, `expected at least half clearance, got ${pinY - points[1].y}`);
});

test('moving pin carries its previous position and pushes a crossed segment ahead', () => {
  const prev = new Map([['B:0', {x: 30, y: 22}]]);
  const index = buildPinSpatialIndex(wires, cell, prev);
  const points = [
    {x: 70, y: -100, ox: 70, oy: -100},
    {x: 70, y: 22, ox: 70, oy: 22},
    {x: 70, y: 150, ox: 70, oy: 150}
  ];
  const contacts = resolveWirePinCollisions('A', points, false, index, cell * 0.98);
  assert.ok(contacts > 0);
  assert.ok(points[1].x > 110, `expected the point ahead of the moving pin, got x=${points[1].x}`);
});

test('fast pin sweep is registered even far from the final pin bucket', () => {
  const prev = new Map([['B:0', {x: -200, y: 22}]]);
  const index = buildPinSpatialIndex(wires, cell, prev);
  const points = [
    {x: -60, y: -100, ox: -60, oy: -100},
    {x: -60, y: 22, ox: -60, oy: 22},
    {x: -60, y: 150, ox: -60, oy: 150}
  ];
  const contacts = resolveWirePinCollisions('A', points, false, index, cell * 0.98);
  assert.ok(contacts > 0, 'expected the swept pin to reach the segment');
  assert.ok(points[1].x > 110, `expected the point ahead of the swept pin, got x=${points[1].x}`);
});

test('a swept pin occupying several buckets is returned once per query', () => {
  const prev = new Map([['B:0', {x: -200, y: 22}]]);
  const index = buildPinSpatialIndex(wires, cell, prev);
  const pins = querySegmentPins(index, {x: -300, y: 22}, {x: 200, y: 22}, cell, 'A');
  assert.deepEqual(pins.map(pin => pin.id), ['B']);
});

test('index reports whether any pin moved since the previous build', () => {
  const staticIndex = buildPinSpatialIndex(wires, cell);
  assert.equal(staticIndex.swept, false);
  const movedIndex = buildPinSpatialIndex(wires, cell, new Map([['B:0', {x: 30, y: 22}]]));
  assert.equal(movedIndex.swept, true);
});

test('slop leaves a contact resting just inside the clearance untouched', () => {
  const index = buildPinSpatialIndex(wires, cell);
  const clearance = cell * 0.98;
  const restY = 22 + clearance - 1;
  const points = [
    {x: 22, y: restY, ox: 22, oy: restY},
    {x: 110, y: restY, ox: 110, oy: restY},
    {x: 198, y: restY, ox: 198, oy: restY}
  ];
  const contacts = resolveWirePinCollisions('A', points, false, index, clearance, {slop: cell * 0.04});
  assert.ok(contacts > 0, 'the contact should still be reported');
  assert.ok(Math.abs(points[1].y - restY) < 1e-9, `expected no positional nudge inside slop, moved to ${points[1].y}`);
});

test('velocity into the pin is cancelled even inside the slop', () => {
  const index = buildPinSpatialIndex(wires, cell);
  const clearance = cell * 0.98;
  const restY = 22 + clearance - 1;
  const points = [
    {x: 22, y: restY, ox: 22, oy: restY},
    {x: 110, y: restY, ox: 110, oy: restY + 3},
    {x: 198, y: restY, ox: 198, oy: restY}
  ];
  resolveWirePinCollisions('A', points, false, index, clearance, {slop: cell * 0.04});
  const inbound = points[1].y - points[1].oy;
  assert.ok(Math.abs(inbound) < 1e-9, `expected the inbound velocity cancelled, got ${inbound}`);
});

test('a pin landing exactly on a segment carries it along the sweep', () => {
  const prev = new Map([['B:0', {x: 30, y: 22}]]);
  const index = buildPinSpatialIndex(wires, cell, prev);
  const points = [
    {x: 110, y: -50, ox: 110, oy: -50},
    {x: 110, y: 22, ox: 110, oy: 22}
  ];
  const contacts = resolveWirePinCollisions('A', points, false, index, cell * 0.98);
  assert.ok(contacts > 0);
  assert.ok(points[1].x > 110, `expected the segment carried ahead of the sweep, got x=${points[1].x}`);
});

test('barycentric correction moves both free segment points away from the pin', () => {
  const index = buildPinSpatialIndex(wires, cell);
  const points = [
    {x: 22, y: -200, ox: 22, oy: -200},
    {x: 22, y: 22, ox: 22, oy: 22},
    {x: 198, y: 22, ox: 198, oy: 22}
  ];
  const contacts = resolveWirePinCollisions('A', points, false, index, cell * 1.06, {correction: 0.35, maxPush: cell * 0.12});
  assert.ok(contacts > 0);
  assert.ok(points[1].y > 22);
  assert.ok(points[2].y > 22);
});

test('a neighbour pin touching the fixed start does not kick the wire', () => {
  const neighbours = [
    {id: 'R', x: 0, y: 0, length: 4, color: '#102cff'},
    {id: 'N', x: 0, y: 1, length: 2, color: '#f200e9'}
  ];
  const index = buildPinSpatialIndex(neighbours, cell);
  const points = [
    {x: 22, y: 22, ox: 22, oy: 22},
    {x: 54, y: 25, ox: 54, oy: 25},
    {x: 86, y: 27, ox: 86, oy: 27}
  ];
  resolveWirePinCollisions('R', points, false, index, cell * 1.06, {
    correction: 0.35, maxPush: cell * 0.5, response: 'position', slop: cell * 0.04
  });
  assert.ok(Math.hypot(points[1].x - 54, points[1].y - 25) < 0.5, `expected no kick near the anchor, moved to ${points[1].x},${points[1].y}`);
});

test('a pin under the anchor still deflects a wire hanging onto it', () => {
  const neighbours = [
    {id: 'R', x: 0, y: 0, length: 4, color: '#102cff'},
    {id: 'N', x: 0, y: 1, length: 2, color: '#f200e9'}
  ];
  const index = buildPinSpatialIndex(neighbours, cell);
  const points = [
    {x: 22, y: 22, ox: 22, oy: 22},
    {x: 23, y: 54, ox: 23, oy: 54},
    {x: 24, y: 86, ox: 24, oy: 86}
  ];
  const contacts = resolveWirePinCollisions('R', points, false, index, cell * 1.06);
  assert.ok(contacts > 0);
  assert.ok(points[2].x > 30, `expected the hanging wire pushed aside, got x=${points[2].x}`);
});

// ─── Контакт с памятью стороны ─────────────────────────────────────────────────

function rope(anchor, count, step, direction = [1, 0]) {
  const points = [];
  for (let i = 0; i < count; i++) {
    const x = anchor[0] + direction[0] * step * i;
    const y = anchor[1] + direction[1] * step * i;
    points.push({x, y, ox: x, oy: y});
  }
  return {points, step};
}

// Тот же цикл, что в редакторе: интеграция, 10 проходов связей и контактов, два финальных прохода.
function simulate(wire, wires, frames, onFrame) {
  let index = buildPinSpatialIndex(wires, cell);
  const p = wire.points;
  let [ax, ay] = [p[0].x, p[0].y];
  for (let frame = 0; frame < frames; frame++) {
    const next = onFrame?.(frame);
    if (next) {
      index = buildPinSpatialIndex(next, cell, index.positions);
      const own = next.find(item => item.id === 'R');
      if (own) [ax, ay] = [center(own.x), center(own.y)];
    }
    for (let i = 1; i < p.length; i++) {
      const q = p[i], vx = (q.x - q.ox) * 0.94, vy = (q.y - q.oy) * 0.94;
      q.ox = q.x; q.oy = q.y; q.x += vx; q.y += vy + 0.22;
    }
    p[0].x = p[0].ox = ax; p[0].y = p[0].oy = ay;
    prepareRopeContacts(wire, 'R', false, index, cell);
    for (let n = 0; n < 10; n++) {
      p[0].x = ax; p[0].y = ay;
      for (let i = 0; i < p.length - 1; i++) {
        const a = p[i], b = p[i + 1], dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, diff = (d - wire.step) / d;
        if (i === 0) { b.x -= dx * diff; b.y -= dy * diff; }
        else { a.x += dx * diff / 2; a.y += dy * diff / 2; b.x -= dx * diff / 2; b.y -= dy * diff / 2; }
      }
      resolveRopeContacts(wire, false, cell, {maxMove: cell / 2});
    }
    for (let n = 0; n < 2; n++) resolveRopeContacts(wire, false, cell, {final: true, maxMove: cell / 2});
    settleRopeContacts(wire);
  }
}

function deepest(wire, pins) {
  let depth = -Infinity;
  const p = wire.points;
  for (const pin of pins) {
    for (let i = 1; i < p.length; i++) {
      const a = p[i - 1], b = p[i], sx = b.x - a.x, sy = b.y - a.y, l = sx * sx + sy * sy || 1;
      const t = Math.max(0, Math.min(1, ((pin.x - a.x) * sx + (pin.y - a.y) * sy) / l));
      depth = Math.max(depth, cell - Math.hypot(a.x + sx * t - pin.x, a.y + sy * t - pin.y));
    }
  }
  return depth;
}

const center = v => (v + 0.5) * cell;

test('touching and diagonal pins form one obstacle, pins two cells apart do not', () => {
  const index = buildPinSpatialIndex([
    {id: 'a', x: 5, y: 5, length: 0}, {id: 'b', x: 6, y: 5, length: 0}, {id: 'c', x: 7, y: 6, length: 0},
    {id: 'd', x: 10, y: 5, length: 0}, {id: 'e', x: 12, y: 5, length: 0}
  ], cell);
  const pins = [...new Map([...index.buckets.values()].flat().map(pin => [pin.order, pin])).values()];
  const of = pinClusters(pins, cell);
  const cluster = id => of.get(pins.find(pin => pin.key === `${id}:0`).order);
  assert.equal(cluster('a'), cluster('b'));
  assert.equal(cluster('b'), cluster('c'));
  assert.notEqual(cluster('d'), cluster('e'));
});

test('a rope flung across a touching pin stays on its side', () => {
  // жгут висит вплотную справа от пина; за один кадр низ жгута бросают влево на 100px
  const wires = [{id: 'R', x: 3, y: 2, length: 8}, {id: 'P', x: 2, y: 6, length: 0}];
  const wire = rope([center(3), center(2)], 12, 8 * cell / 11, [0, 1]);
  simulate(wire, wires, 120);
  for (const point of wire.points.slice(3)) point.ox = point.x + 100;
  simulate(wire, wires, 1);
  const pin = {x: center(2), y: center(6)};
  const level = wire.points.filter(point => Math.abs(point.y - pin.y) < cell / 2);
  assert.ok(level.length && level.every(point => point.x > pin.x), `rope got past the pin: ${level.map(point => point.x.toFixed(0))}`);
  assert.ok(deepest(wire, [pin]) < 0.5);
});

test('a rope swung onto two touching pins rests on them without jitter or overlap', () => {
  const pins = [{id: 'a', x: 10, y: 6, length: 0}, {id: 'b', x: 11, y: 6, length: 0}];
  const wires = [{id: 'R', x: 6, y: 2, length: 9}, ...pins];
  const wire = rope([center(6), center(2)], 13, 9 * cell / 12);
  simulate(wire, wires, 400);
  const before = wire.points.map(point => [point.x, point.y]);
  simulate(wire, wires, 60);
  const motion = Math.max(...wire.points.map((point, i) => Math.hypot(point.x - before[i][0], point.y - before[i][1])));
  assert.ok(motion < 0.5, `rope still moves by ${motion.toFixed(2)}px`);
  assert.ok(deepest(wire, pins.map(pin => ({x: center(pin.x), y: center(pin.y)}))) < 0.5);
});

test('a rope born lying through touching pins keeps its path and stays still', () => {
  const pins = [{id: 'a', x: 10, y: 6, length: 0}, {id: 'b', x: 11, y: 6, length: 0}];
  const wires = [{id: 'R', x: 10, y: 1, length: 10}, ...pins];
  const wire = rope([center(10), center(1)], 14, 10 * cell / 13, [0, 1]);
  simulate(wire, wires, 300);
  const before = wire.points.map(point => [point.x, point.y]);
  simulate(wire, wires, 60);
  const motion = Math.max(...wire.points.map((point, i) => Math.hypot(point.x - before[i][0], point.y - before[i][1])));
  assert.ok(motion < 0.5, `rope still moves by ${motion.toFixed(2)}px`);
  assert.ok(wire.contact.ghost.size >= 1, 'pins the rope was born through are ignored');
});

test('a pin dropped onto a hanging rope pushes the rope fully aside', () => {
  const wires = [{id: 'R', x: 8, y: 2, length: 8}];
  const wire = rope([center(8), center(2)], 12, 8 * cell / 11, [0, 1]);
  simulate(wire, wires, 120);
  const dropped = [...wires, {id: 'D', x: 8, y: 6, length: 0}];
  simulate(wire, dropped, 400, frame => (frame === 0 ? dropped : null));
  assert.ok(deepest(wire, [{x: center(8), y: center(6)}]) < 0.5, 'rope left the dropped pin');
});

test('a start led by a shaky hand along a gap between pins drags the rope without jerks or cutting through', () => {
  // проход между рядами точек ровно в толщину жгута: рука ходит на треть клетки, ручка то и дело заходит в точки
  const pins = [2, 4, 6, 8].flatMap(x => [3, 5, 7].map(y => ({id: `p${x}${y}`, x, y, length: 0})));
  const centers = pins.map(pin => ({x: center(pin.x), y: center(pin.y)}));
  const wire = rope([center(1), center(4)], 12, 8 * cell / 11, [0, 1]);
  const hand = frame => {
    const t = Math.min(1, frame / 240);
    return {x: 1 + 8 * t + (t < 1 ? 0.33 * Math.sin(frame * 0.09) : 0), y: 4 + (t < 1 ? 0.33 * Math.sin(frame * 0.07 + 2) : 0)};
  };
  let worstJerk = 0, worstCut = 0;
  let before = wire.points.map(point => [point.x, point.y]);
  simulate(wire, [{id: 'R', x: 1, y: 4, length: 8}, ...pins], 360, frame => {
    if (frame) {
      worstJerk = Math.max(worstJerk, ...wire.points.slice(1).map((point, i) => Math.hypot(point.x - before[i + 1][0], point.y - before[i + 1][1])));
      const start = wire.points[0];
      const handDepth = Math.max(0, ...centers.map(pin => cell - Math.hypot(start.x - pin.x, start.y - pin.y)));
      worstCut = Math.max(worstCut, deepest(wire, centers) - handDepth);
    }
    before = wire.points.map(point => [point.x, point.y]);
    return [{id: 'R', ...hand(frame), length: 8}, ...pins];
  });
  assert.ok(worstJerk < cell / 3, `rope jerked by ${worstJerk.toFixed(1)}px in a frame`);
  assert.ok(worstCut < cell / 10, `rope went ${worstCut.toFixed(1)}px deeper into a pin than the hand did`);
  assert.ok(deepest(wire, centers) < 0.5, 'rope rests clear of the pins');
});
