import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_FILE_BYTES, MAX_WIRES} from '../src/model.js';
import {parseWires, serializeWires} from '../src/wires-format.js';

const state = {
  version: 1,
  cell: 44,
  background: '#102cff',
  pointMode: 'wire',
  gridVisible: false,
  wires: [
    {id: 'A', x: 1, y: 2, length: 3.5, color: '#f200e9'},
    {id: 'B', x: 4, y: 5, length: 6, color: '#102cff', endX: 8, endY: 9}
  ]
};

test('serializeWires and parseWires round-trip canonical state', () => {
  const text = serializeWires(state);
  assert.match(text, /^wires 1\ncanvas 44 #102cff\npoints wire\ngrid hidden\n\n/);
  assert.deepEqual(parseWires(text), state);
});

test('parseWires accepts comments and migrates legacy interface mode', () => {
  const parsed = parseWires('wires 1\n# comment\npoints interface\nwire A x 1 y 2 length 3 color #102cff\n');
  assert.equal(parsed.pointMode, 'white');
  assert.equal(parsed.wires.length, 1);
});

test('parseWires rejects malformed structure and duplicate IDs', () => {
  assert.throws(() => parseWires('wire A x 1 y 2 length 3 color #102cff\n'), /Первая строка/);
  assert.throws(() => parseWires('wires 1\nwire A x 1 y 2 length 3 color #102cff EXTRA\n'), /формат wire/);
  assert.throws(() => parseWires('wires 1\nwire A x 1 y 2 length 3 color #102cff\nwire A x 2 y 2 length 3 color #102cff\n'), /повторяется/);
  assert.throws(() => parseWires('wires 1\npoints invisible\n'), /режим точек/);
});

test('parseWires enforces object and byte limits', () => {
  const rows = ['wires 1'];
  for (let index = 0; index <= MAX_WIRES; index++) rows.push(`wire W${index} x ${index} y 0 length 0 color #102cff`);
  assert.throws(() => parseWires(`${rows.join('\n')}\n`), /не более 1000/);
  assert.throws(() => parseWires(`wires 1\n#${'x'.repeat(MAX_FILE_BYTES)}\n`), /1 МБ/);
});

test('serializeWires writes wire shapes as wires 2 and parseWires reads them back', () => {
  const shapes = {B: [4, 5, 5.25, 7.5, 8, 9]};
  const text = serializeWires(state, shapes);
  assert.match(text, /^wires 2\n/);
  assert.match(text, /\nwire B x 4 y 5 length 6 color #102cff end 8 9\nshape 4 5 5.25 7.5 8 9\n/);
  assert.deepEqual(parseWires(text), {...state, shapes});
  assert.match(serializeWires(state, {}), /^wires 1\n/);
});

test('parseWires rejects misplaced or malformed shapes', () => {
  const head = 'wires 2\nwire A x 1 y 2 length 3 color #102cff\n';
  assert.throws(() => parseWires('wires 2\nshape 1 2 3 4\n'), /сразу после/);
  assert.throws(() => parseWires(`${head}# comment\ngrid visible\nshape 1 2 3 4\n`), /сразу после/);
  assert.throws(() => parseWires(`${head}shape 1 2 3\n`), /пар координат/);
  assert.throws(() => parseWires(`${head}shape ${Array(130).fill(1).join(' ')}\n`), /пар координат/);
  assert.throws(() => parseWires(`${head}shape 1 2 x 4\n`), /числами/);
});
