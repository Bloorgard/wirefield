import {
  BACKGROUNDS,
  ID_RE,
  MAX_COORD,
  MAX_FILE_BYTES,
  MAX_LENGTH,
  MAX_WIRES,
  hasTail
} from './model.js';

export function serializeWires(state) {
  const lines = [
    'wires 1',
    `canvas ${state.cell} ${state.background}`,
    `points ${state.pointMode}`,
    `grid ${state.gridVisible ? 'visible' : 'hidden'}`,
    ''
  ];
  state.wires.forEach(wire => lines.push(
    `wire ${wire.id} x ${wire.x} y ${wire.y} length ${wire.length} color ${wire.color}${hasTail(wire) ? ` end ${wire.endX} ${wire.endY}` : ''}`
  ));
  return `${lines.join('\n')}\n`;
}

export function parseWires(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_FILE_BYTES) {
    throw Error('Файл превышает допустимый размер 1 МБ');
  }
  const rows = text.split(/\r?\n/);
  const lines = rows
    .map((raw, index) => ({text: raw.trim(), number: index + 1}))
    .filter(row => row.text && !row.text.startsWith('#'));
  if (lines[0]?.text !== 'wires 1') throw Error('Первая строка должна быть «wires 1»');

  const output = {version: 1, cell: 44, background: '#f200e9', pointMode: 'white', gridVisible: true, wires: []};
  const ids = new Set();

  for (const row of lines.slice(1)) {
    const parts = row.text.split(/\s+/);
    const fail = message => { throw Error(`Строка ${row.number}: ${message}`); };

    if (parts[0] === 'canvas') {
      const cell = Number(parts[1]);
      const background = String(parts[2] || '').toLowerCase();
      if (!Number.isFinite(cell) || cell < 24 || cell > 80) fail('размер клетки должен быть от 24 до 80');
      if (!BACKGROUNDS.some(theme => theme.color === background)) fail('неизвестный фон');
      output.cell = cell;
      output.background = background;
      continue;
    }

    if (parts[0] === 'points') {
      const mode = parts[1] === 'interface' ? 'white' : parts[1];
      if (!['white', 'wire', 'background'].includes(mode)) fail('режим точек должен быть white, wire или background');
      output.pointMode = mode;
      continue;
    }

    if (parts[0] === 'grid') {
      if (!['visible', 'hidden'].includes(parts[1])) fail('режим сетки должен быть visible или hidden');
      output.gridVisible = parts[1] === 'visible';
      continue;
    }

    if (parts[0] === 'wire') {
      if (output.wires.length >= MAX_WIRES) fail(`допустимо не более ${MAX_WIRES} жгутов`);
      if (parts.length !== 10 && parts.length !== 13) fail('формат wire: wire ID x X y Y length L color #RRGGBB [end X Y]');
      const id = parts[1];
      if (!ID_RE.test(id || '')) fail('ID должен содержать 1–64 символа A–Z, a–z, 0–9, _ или -');
      if (ids.has(id)) fail(`ID ${id} повторяется`);
      if (parts[2] !== 'x' || parts[4] !== 'y' || parts[6] !== 'length' || parts[8] !== 'color' || (parts.length === 13 && parts[10] !== 'end')) {
        fail('поля wire должны идти в порядке x, y, length, color, end');
      }
      ids.add(id);
      const wire = {id, x: Number(parts[3]), y: Number(parts[5]), length: Number(parts[7]), color: parts[9]};
      if ([wire.x, wire.y, wire.length].some(value => !Number.isFinite(value))) fail('x, y и length должны быть числами');
      if (wire.x < 0 || wire.y < 0 || wire.x > MAX_COORD || wire.y > MAX_COORD) fail(`координаты должны быть от 0 до ${MAX_COORD}`);
      if (wire.length < 0 || wire.length > MAX_LENGTH) fail(`длина должна быть от 0 до ${MAX_LENGTH}`);
      if (!/^#[0-9a-f]{6}$/i.test(wire.color || '')) fail('цвет должен иметь формат #RRGGBB');
      if (parts.length === 13) {
        wire.endX = Number(parts[11]);
        wire.endY = Number(parts[12]);
        if (!Number.isFinite(wire.endX) || !Number.isFinite(wire.endY) || wire.endX < 0 || wire.endY < 0 || wire.endX > MAX_COORD || wire.endY > MAX_COORD) {
          fail(`end должен содержать координаты от 0 до ${MAX_COORD}`);
        }
      }
      output.wires.push(wire);
      continue;
    }

    fail(`неизвестная команда ${parts[0]}`);
  }

  return output;
}
