import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_WIRES,
  hasTail,
  nearestFreeIn,
  normalizeModel,
  pinCells,
  tailMinimumLength
} from '../src/model.js';

const fallback = {
  version: 1,
  cell: 44,
  background: '#102cff',
  pointMode: 'white',
  gridVisible: true,
  wires: [{id: 'fallback', x: 1, y: 1, length: 1, color: '#102cff'}]
};

test('normalizeModel falls back and migrates legacy point state', () => {
  assert.deepEqual(normalizeModel(null, fallback), fallback);
  const migrated = normalizeModel({version: 1, cell: 44, background: '#f200e9', pointsMatchBackground: true, wires: []}, fallback);
  assert.equal(migrated.pointMode, 'background');
});

test('normalizeModel repairs IDs, coordinates, colors, and occupied starts', () => {
  const normalized = normalizeModel({
    version: 1,
    cell: 999,
    background: '#invalid',
    pointMode: 'wire',
    gridVisible: false,
    wires: [
      {id: 'same', x: -2, y: 3.6, length: 99, color: 'bad'},
      {id: 'same', x: 0, y: 4, length: 1.24, color: '#f200e9'}
    ]
  }, fallback);
  assert.equal(normalized.cell, 80);
  assert.equal(normalized.background, fallback.background);
  assert.equal(normalized.pointMode, 'wire');
  assert.equal(normalized.gridVisible, false);
  assert.deepEqual(normalized.wires.map(wire => wire.id), ['same', '0002']);
  assert.deepEqual(normalized.wires.map(wire => [wire.x, wire.y]), [[0, 4], [1, 4]]);
  assert.equal(normalized.wires[0].length, 48);
  assert.equal(normalized.wires[0].color, '#102cff');
  assert.equal(normalized.wires[1].length, 1);
});

test('normalizeModel caps external state at MAX_WIRES', () => {
  const wires = Array.from({length: MAX_WIRES + 1}, (_, index) => ({
    id: String(index + 1), x: index, y: 0, length: 0, color: '#102cff'
  }));
  assert.equal(normalizeModel({version: 1, wires}, fallback).wires.length, MAX_WIRES);
});

test('tail helpers enforce minimum length and occupied pin cells', () => {
  const wire = {id: 'A', x: 1, y: 1, length: 1, color: '#102cff', endX: 4, endY: 5};
  assert.equal(tailMinimumLength(wire), 5);
  const normalized = normalizeModel({version: 1, cell: 44, background: '#f200e9', pointMode: 'white', wires: [wire]}, fallback);
  assert.equal(normalized.wires[0].length, 5);
  assert.equal(hasTail(normalized.wires[0]), true);
  assert.deepEqual([...pinCells(normalized.wires)].sort(), ['1,1', '4,5']);
});

test('nearestFreeIn uses deterministic right-first breadth search', () => {
  const wires = [
    {id: 'A', x: 2, y: 2, length: 0},
    {id: 'B', x: 3, y: 2, length: 0}
  ];
  assert.deepEqual(nearestFreeIn(wires, 2, 2), {x: 2, y: 3});
  assert.deepEqual(nearestFreeIn(wires, -2, -3), {x: 0, y: 0});
});

test('nearestFreeIn treats pinned tails as occupied cells', () => {
  const wires = [{id: 'A', x: 5, y: 5, length: 5, color: '#102cff', endX: 8, endY: 5}];
  assert.deepEqual(nearestFreeIn(wires, 8, 5), {x: 9, y: 5});
  assert.deepEqual(nearestFreeIn(wires, 8, 5, 'A'), {x: 8, y: 5});
});

test('normalizeModel keeps starts off foreign pinned tails', () => {
  const normalized = normalizeModel({
    version: 1,
    wires: [
      {id: 'A', x: 5, y: 5, length: 5, color: '#102cff', endX: 8, endY: 5},
      {id: 'B', x: 8, y: 5, length: 2, color: '#102cff'}
    ]
  }, fallback);
  assert.deepEqual([...pinCells(normalized.wires)].sort(), ['5,5', '8,5', '9,5']);
});
