import {performance} from 'node:perf_hooks';
import {buildPinSpatialIndex, querySegmentPins} from '../src/collision.js';

const CELL = 44;
const CLEARANCE = CELL * 0.98;
const SEGMENTS = 8;
const SIZES = [100, 500, 1000];

function fixture(count) {
  const width = Math.ceil(Math.sqrt(count));
  return Array.from({length: count}, (_, index) => ({
    id: `W${index}`,
    x: index % width,
    y: Math.floor(index / width),
    length: 4,
    color: '#102cff',
    endX: index % width,
    endY: Math.floor(index / width) + 1
  }));
}

function pointsFor(wire) {
  const startX = (wire.x + 0.5) * CELL;
  const startY = (wire.y + 0.5) * CELL;
  return Array.from({length: SEGMENTS + 1}, (_, index) => ({x: startX + index * CELL * 0.5, y: startY}));
}

function collides(start, end, pin) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy || 1;
  const projection = Math.max(0, Math.min(1, ((pin.x - start.x) * dx + (pin.y - start.y) * dy) / lengthSquared));
  return Math.hypot(start.x + dx * projection - pin.x, start.y + dy * projection - pin.y) < CLEARANCE;
}

function allPins(wires) {
  const pins = [];
  for (const wire of wires) {
    pins.push({id: wire.id, x: (wire.x + 0.5) * CELL, y: (wire.y + 0.5) * CELL});
    pins.push({id: wire.id, x: (wire.endX + 0.5) * CELL, y: (wire.endY + 0.5) * CELL});
  }
  return pins;
}

function legacyScan(wires) {
  const pins = allPins(wires);
  let checks = 0;
  let contacts = 0;
  for (const wire of wires) {
    const points = pointsFor(wire);
    for (let segment = 0; segment < SEGMENTS; segment++) {
      for (const pin of pins) {
        if (pin.id === wire.id) continue;
        checks++;
        if (collides(points[segment], points[segment + 1], pin)) contacts++;
      }
    }
  }
  return {checks, contacts};
}

function spatialScan(wires) {
  const index = buildPinSpatialIndex(wires, CELL);
  let checks = 0;
  let contacts = 0;
  for (const wire of wires) {
    const points = pointsFor(wire);
    for (let segment = 0; segment < SEGMENTS; segment++) {
      const candidates = querySegmentPins(index, points[segment], points[segment + 1], CLEARANCE, wire.id);
      checks += candidates.length;
      for (const pin of candidates) if (collides(points[segment], points[segment + 1], pin)) contacts++;
    }
  }
  return {checks, contacts};
}

function measure(fn, wires) {
  const started = performance.now();
  const result = fn(wires);
  return {...result, milliseconds: performance.now() - started};
}

console.log('| wires | legacy ms | spatial ms | speedup | legacy checks | spatial checks | reduction |');
console.log('|---:|---:|---:|---:|---:|---:|---:|');
for (const size of SIZES) {
  const wires = fixture(size);
  const legacy = measure(legacyScan, wires);
  const spatial = measure(spatialScan, wires);
  if (legacy.contacts !== spatial.contacts) throw new Error(`contact mismatch at ${size}: ${legacy.contacts} !== ${spatial.contacts}`);
  const speedup = legacy.milliseconds / spatial.milliseconds;
  const reduction = legacy.checks / spatial.checks;
  console.log(`| ${size} | ${legacy.milliseconds.toFixed(2)} | ${spatial.milliseconds.toFixed(2)} | ${speedup.toFixed(1)}x | ${legacy.checks} | ${spatial.checks} | ${reduction.toFixed(1)}x |`);
}
