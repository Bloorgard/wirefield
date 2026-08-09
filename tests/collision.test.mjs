import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPinSpatialIndex, querySegmentPins, resolveWirePinCollisions} from '../src/collision.js';

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
