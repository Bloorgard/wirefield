import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPinSpatialIndex, collectSegmentCandidates, querySegmentPins, resolveWirePinCollisions} from '../src/collision.js';

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
