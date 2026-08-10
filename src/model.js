export const COLORS = ['#102cff', '#f200e9', '#0b1118', '#f8f5ed', '#ffc642', '#00e69c'];

export const BACKGROUNDS = [
  {color: '#f200e9', label: 'розовый', ink: '#f8f5ed', grid: 'rgba(255,255,255,.48)'},
  {color: '#102cff', label: 'синий', ink: '#f8f5ed', grid: 'rgba(255,255,255,.48)'},
  {color: '#ffffff', label: 'белый', ink: '#102cff', grid: 'rgba(16,44,255,.22)'}
];

export const MAX_LENGTH = 48;
export const MAX_WIRES = 1000;
export const MAX_COORD = 100000;
export const MAX_FILE_BYTES = 1024 * 1024;
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const pad = value => String(value).padStart(4, '0');

export function hasTail(wire) {
  return wire.length > 0 && Number.isFinite(wire.endX) && Number.isFinite(wire.endY);
}

export function tailMinimumLength(wire, endX = wire.endX, endY = wire.endY) {
  if (!Number.isFinite(endX) || !Number.isFinite(endY)) return 0;
  return Math.max(0.5, Math.ceil((Math.hypot(endX - wire.x, endY - wire.y) - 1e-9) * 2) / 2);
}

export function pinCells(wires, excludeIds = new Set()) {
  const occupied = new Set();
  for (const wire of wires) {
    if (excludeIds.has(wire.id)) continue;
    occupied.add(`${wire.x},${wire.y}`);
    if (hasTail(wire)) occupied.add(`${wire.endX},${wire.endY}`);
  }
  return occupied;
}

export function nearestFreeIn(wires, x, y, excludeId = null) {
  x = Math.max(0, Math.round(x));
  y = Math.max(0, Math.round(y));
  const taken = pinCells(wires, new Set(excludeId === null ? [] : [excludeId]));
  const occupied = (px, py) => taken.has(`${px},${py}`);
  if (!occupied(x, y)) return {x, y};
  const queue = [[x, y]];
  const seen = new Set([`${x},${y}`]);
  const directions = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  for (let index = 0; index < queue.length && index < 10000; index++) {
    const [currentX, currentY] = queue[index];
    for (const [dx, dy] of directions) {
      const nextX = currentX + dx;
      const nextY = currentY + dy;
      const key = `${nextX},${nextY}`;
      if (nextX < 0 || nextY < 0 || seen.has(key)) continue;
      if (!occupied(nextX, nextY)) return {x: nextX, y: nextY};
      seen.add(key);
      queue.push([nextX, nextY]);
    }
  }
  return {x, y};
}

export function safeId(raw, index, used) {
  const candidate = String(raw ?? '').trim();
  const base = ID_RE.test(candidate) ? candidate : pad(index + 1);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let number = index + 1;
  let id;
  do id = pad(number++); while (used.has(id));
  used.add(id);
  return id;
}

export function normalizeModel(data, fallback) {
  const sourceFallback = fallback && Array.isArray(fallback.wires)
    ? fallback
    : {version: 1, cell: 44, background: '#f200e9', pointMode: 'white', gridVisible: true, wires: []};
  const safe = data && Array.isArray(data.wires) ? data : structuredClone(sourceFallback);
  const used = new Set();
  const wires = safe.wires.slice(0, MAX_WIRES).map((raw, index) => {
    const value = raw && typeof raw === 'object' ? raw : {};
    const wire = {
      id: safeId(value.id, index, used),
      x: Math.max(0, Math.min(MAX_COORD, Math.round(Number(value.x) || 0))),
      y: Math.max(0, Math.min(MAX_COORD, Math.round(Number(value.y) || 0))),
      length: Math.max(0, Math.min(MAX_LENGTH, Math.round((Number.isFinite(Number(value.length)) ? Number(value.length) : 0.5) * 2) / 2)),
      color: /^#[0-9a-f]{6}$/i.test(value.color) ? value.color : COLORS[0]
    };
    if (wire.length > 0 && Number.isFinite(Number(value.endX)) && Number.isFinite(Number(value.endY))) {
      const endX = Math.max(0, Math.min(MAX_COORD, Math.round(Number(value.endX))));
      const endY = Math.max(0, Math.min(MAX_COORD, Math.round(Number(value.endY))));
      const minimum = tailMinimumLength(wire, endX, endY);
      if (minimum <= MAX_LENGTH) {
        wire.endX = endX;
        wire.endY = endY;
        wire.length = Math.max(wire.length, minimum);
      }
    }
    return wire;
  });

  const placed = [];
  for (const wire of wires) {
    const position = nearestFreeIn(placed, wire.x, wire.y);
    wire.x = position.x;
    wire.y = position.y;
    if (hasTail(wire) && pinCells(placed).has(`${wire.endX},${wire.endY}`)) {
      delete wire.endX;
      delete wire.endY;
    }
    const minimum = tailMinimumLength(wire);
    if (hasTail(wire)) {
      if (minimum <= MAX_LENGTH) wire.length = Math.max(wire.length, minimum);
      else {
        delete wire.endX;
        delete wire.endY;
      }
    }
    placed.push(wire);
  }

  const background = typeof safe.background === 'string' && BACKGROUNDS.some(theme => theme.color === safe.background.toLowerCase())
    ? safe.background.toLowerCase()
    : sourceFallback.background;
  const pointMode = ['white', 'wire', 'background'].includes(safe.pointMode)
    ? safe.pointMode
    : safe.pointsMatchBackground === true ? 'background' : 'white';

  return {
    version: 1,
    cell: Math.max(24, Math.min(80, Number(safe.cell) || 44)),
    background,
    pointMode,
    gridVisible: safe.gridVisible !== false,
    wires: placed
  };
}
