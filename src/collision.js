import {hasTail} from './model.js';

const key = (x, y) => `${x},${y}`;

export function buildPinSpatialIndex(wires, cellSize, prevPositions) {
  const buckets = new Map();
  const positions = new Map();
  let order = 0;
  let swept = false;
  const add = (id, pinKey, x, y) => {
    const prev = prevPositions ? prevPositions.get(pinKey) : null;
    const px = prev ? prev.x : x;
    const py = prev ? prev.y : y;
    if (Math.abs(px - x) > 1e-6 || Math.abs(py - y) > 1e-6) swept = true;
    const pin = {id, key: pinKey, x, y, px, py, order: order++};
    const minBucketX = Math.floor(Math.min(x, px) / cellSize);
    const maxBucketX = Math.floor(Math.max(x, px) / cellSize);
    const minBucketY = Math.floor(Math.min(y, py) / cellSize);
    const maxBucketY = Math.floor(Math.max(y, py) / cellSize);
    for (let bucketY = minBucketY; bucketY <= maxBucketY; bucketY++) {
      for (let bucketX = minBucketX; bucketX <= maxBucketX; bucketX++) {
        const bucketKey = key(bucketX, bucketY);
        const bucket = buckets.get(bucketKey);
        if (bucket) bucket.push(pin);
        else buckets.set(bucketKey, [pin]);
      }
    }
    positions.set(pinKey, {x, y});
  };
  for (const wire of wires) {
    add(wire.id, `${wire.id}:0`, (wire.x + 0.5) * cellSize, (wire.y + 0.5) * cellSize);
    if (hasTail(wire)) add(wire.id, `${wire.id}:1`, (wire.endX + 0.5) * cellSize, (wire.endY + 0.5) * cellSize);
  }
  return {cellSize, buckets, positions, swept, pinCount: order};
}

export function querySegmentPins(index, start, end, clearance, excludeId) {
  const minBucketX = Math.floor((Math.min(start.x, end.x) - clearance) / index.cellSize);
  const maxBucketX = Math.floor((Math.max(start.x, end.x) + clearance) / index.cellSize);
  const minBucketY = Math.floor((Math.min(start.y, end.y) - clearance) / index.cellSize);
  const maxBucketY = Math.floor((Math.max(start.y, end.y) + clearance) / index.cellSize);
  const candidates = [];
  for (let bucketY = minBucketY; bucketY <= maxBucketY; bucketY++) {
    for (let bucketX = minBucketX; bucketX <= maxBucketX; bucketX++) {
      const bucket = index.buckets.get(key(bucketX, bucketY));
      if (!bucket) continue;
      for (const pin of bucket) if (pin.id !== excludeId) candidates.push(pin);
    }
  }
  candidates.sort((left, right) => left.order - right.order);
  const deduped = [];
  let lastOrder = -1;
  for (const pin of candidates) {
    if (pin.order !== lastOrder) {
      deduped.push(pin);
      lastOrder = pin.order;
    }
  }
  return deduped;
}

export function collectSegmentCandidates(index, points, clearance, excludeId) {
  const lists = [];
  for (let segment = 0; segment < points.length - 1; segment++) {
    lists.push(querySegmentPins(index, points[segment], points[segment + 1], clearance, excludeId));
  }
  return lists;
}

function moveContact(point, dx, dy, normalX, normalY, positionOnly) {
  point.x += dx;
  point.y += dy;
  point.ox += dx;
  point.oy += dy;
  if (positionOnly) return;
  const velocityX = point.x - point.ox;
  const velocityY = point.y - point.oy;
  const normalVelocity = velocityX * normalX + velocityY * normalY;
  const tangentX = velocityX - normalVelocity * normalX;
  const tangentY = velocityY - normalVelocity * normalY;
  const keptNormal = Math.max(0, normalVelocity) * 0.35;
  const keptVelocityX = tangentX * 0.72 + normalX * keptNormal;
  const keptVelocityY = tangentY * 0.72 + normalY * keptNormal;
  point.ox = point.x - keptVelocityX;
  point.oy = point.y - keptVelocityY;
}

export function resolveWirePinCollisions(wireId, points, pinned, index, clearance, options = {}) {
  const correction = Number.isFinite(options.correction) ? options.correction : 1;
  const maxPush = Number.isFinite(options.maxPush) ? options.maxPush : Infinity;
  const positionOnly = options.response === 'position';
  const slop = Number.isFinite(options.slop) ? options.slop : 0;
  const candidates = options.candidates || null;
  const last = points.length - 1;
  let contacts = 0;
  for (let segment = 0; segment < last; segment++) {
    const start = points[segment];
    const end = points[segment + 1];
    const fixedStart = segment === 0;
    const fixedEnd = pinned && segment + 1 === last;
    const pins = candidates ? candidates[segment] : querySegmentPins(index, start, end, clearance, wireId);
    for (const pin of pins) {
      const segmentX = end.x - start.x;
      const segmentY = end.y - start.y;
      const lengthSquared = segmentX * segmentX + segmentY * segmentY || 1;
      const projection = Math.max(0, Math.min(1, ((pin.x - start.x) * segmentX + (pin.y - start.y) * segmentY) / lengthSquared));
      const nearX = start.x + segmentX * projection;
      const nearY = start.y + segmentY * projection;
      const deltaX = nearX - pin.x;
      const deltaY = nearY - pin.y;
      const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
      const pinPrevX = pin.px !== undefined ? pin.px : pin.x;
      const pinPrevY = pin.py !== undefined ? pin.py : pin.y;
      const prevSegX = end.ox - start.ox;
      const prevSegY = end.oy - start.oy;
      const prevLengthSquared = prevSegX * prevSegX + prevSegY * prevSegY || 1;
      const prevProjection = Math.max(0, Math.min(1, ((pinPrevX - start.ox) * prevSegX + (pinPrevY - start.oy) * prevSegY) / prevLengthSquared));
      const prevDeltaX = start.ox + prevSegX * prevProjection - pinPrevX;
      const prevDeltaY = start.oy + prevSegY * prevProjection - pinPrevY;
      const crossed = prevDeltaX * deltaX + prevDeltaY * deltaY < 0;
      if (!crossed && distance >= clearance) continue;
      contacts++;
      const segmentLength = Math.sqrt(lengthSquared);
      let normalX, normalY, penetration;
      if (crossed) {
        const prevDistance = Math.sqrt(prevDeltaX * prevDeltaX + prevDeltaY * prevDeltaY);
        normalX = prevDistance > 1e-6 ? prevDeltaX / prevDistance : (-segmentY / segmentLength || 1);
        normalY = prevDistance > 1e-6 ? prevDeltaY / prevDistance : (segmentX / segmentLength || 0);
        penetration = clearance + distance;
      } else if (distance > 1e-6) {
        normalX = deltaX / distance;
        normalY = deltaY / distance;
        penetration = Math.max(0, clearance - distance - slop);
      } else {
        const prevDistance = Math.sqrt(prevDeltaX * prevDeltaX + prevDeltaY * prevDeltaY);
        normalX = prevDistance > 1e-6 ? prevDeltaX / prevDistance : (-segmentY / segmentLength || 1);
        normalY = prevDistance > 1e-6 ? prevDeltaY / prevDistance : (segmentX / segmentLength || 0);
        penetration = Math.max(0, clearance - distance - slop);
      }
      const push = Math.min(maxPush, penetration * correction);
      const startWeight = fixedStart ? 0 : 1 - projection;
      const endWeight = fixedEnd ? 0 : projection;
      // У отрезка с закреплённым концом точное решение сдвигает свободную точку
      // на push/t: пин соседней клетки у самого конца бьёт её на maxPush каждый
      // кадр, и жгуты, стартующие рядом, дрожат вечно. Вес t вместо 1/t гасит
      // такой контакт плавно, без порога, а вдали от конца его добирают итерации.
      const denominator = fixedStart || fixedEnd ? 1 : startWeight * startWeight + endWeight * endWeight;
      if (startWeight + endWeight <= 1e-8) continue;
      if (startWeight > 0) {
        const startPush = Math.min(maxPush, push * startWeight / denominator);
        moveContact(start, normalX * startPush, normalY * startPush, normalX, normalY, positionOnly);
      }
      if (endWeight > 0) {
        const endPush = Math.min(maxPush, push * endWeight / denominator);
        moveContact(end, normalX * endPush, normalY * endPush, normalX, normalY, positionOnly);
      }
    }
  }
  return contacts;
}

// ─── Контакт жгута с пинами, который помнит сторону ────────────────────────────
//
// Пины, между которыми жгут не пролезает (центры ближе двух зазоров), — одно
// препятствие: у их зон запрета общий «перешеек», и толчки соседних пинов
// в нём направлены навстречу друг другу. Поэтому каждому пину в контакте жгут
// назначает сторону — слева он от отрезка или справа — и выталкивает отрезок
// только на эту сторону и до конца, без частичных поправок.
//
// Сторона берётся из начала кадра, когда пин там явно по одну сторону. Память
// нужна только глубокому контакту: после пролёта, после загрузки, когда пин
// поставили прямо на жгут. Такой контакт держит прежнюю сторону; впервые
// увиденный — идёт туда, где уже лежит бо́льшая часть жгута. Закреплённый конец,
// заведённый в пин, сжимает зазор до этого пина ровно до себя.

// Пин глубже половины зазора от оси отрезка — «глубокий»: по геометрии уже
// не понять, с какой он стороны.
const DEEP = 0.5;

// Прямая от конца к точке жгута, которая проходит мимо пина ближе 0.9 зазора, режет пин:
// жгут огибает его. Прислонённый пин прямую не режет — жгут у него остаётся прямым.
const SIGHT = 0.9;

// Пины рядом с жгутом, без его собственных: иначе его же старт склеивал бы соседей в одно препятствие.
export function pinClusters(pins, clearance) {
  const parent = new Map(pins.map(pin => [pin.order, pin.order]));
  const find = order => {
    while (parent.get(order) !== order) {
      parent.set(order, parent.get(parent.get(order)));
      order = parent.get(order);
    }
    return order;
  };
  const limit = (2 * clearance - 1e-6) ** 2;
  for (let i = 0; i < pins.length; i++) {
    for (let j = i + 1; j < pins.length; j++) {
      if ((pins[j].x - pins[i].x) ** 2 + (pins[j].y - pins[i].y) ** 2 < limit) parent.set(find(pins[i].order), find(pins[j].order));
    }
  }
  const of = new Map();
  for (const pin of pins) of.set(pin.order, find(pin.order));
  return of;
}

function recall(contacts, segment, key) {
  for (const offset of [0, -1, 1, -2, 2]) {
    const list = contacts[segment + offset];
    if (!list) continue;
    for (const contact of list) if (contact.pin.key === key) return contact.side;
  }
  return 0;
}

// Раз в кадр, после интеграции: кандидаты, стороны, «призраки».
// options.ghosts: 'lasting' — новый жгут не трогает пины, в которых родился, пока из них
// не выйдет; 'end' — призраков нет. Какое правило лучше, решается в полигоне.
export function prepareRopeContacts(rope, wireId, pinned, index, clearance, options = {}) {
  const lasting = options.ghosts !== 'end';
  const points = rope.points;
  const segments = points.length - 1;
  const state = rope.contact || (rope.contact = {contacts: [], ghost: new Set(), age: 0});
  let memory = state.contacts;
  if (memory.length !== segments && memory.length) {
    // длина поменялась и жгут пересэмплирован: память переезжает по месту вдоль жгута
    memory = Array.from({length: segments}, (_, j) => memory[Math.min(memory.length - 1, Math.round(j * memory.length / segments))]);
  }
  for (const point of points) point.contactX = point.contactY = undefined;
  let candidates = segments > 0 ? collectSegmentCandidates(index, points, clearance + index.cellSize, wireId) : [];
  if (options.exclude) candidates = candidates.map(list => list.filter(pin => !options.exclude(pin)));
  const near = new Map();
  for (const list of candidates) for (const pin of list) near.set(pin.order, pin);
  const clusterOf = pinClusters([...near.values()], clearance);
  const next = Array.from({length: Math.max(0, segments)}, () => []);
  state.contacts = next;
  state.seeStart = Infinity;
  state.seeEnd = -Infinity;
  if (segments <= 0) return;
  // если пины растянули жгут целиком, он растянут равномерно — натяжение от концов меряет
  // длину с этой растяжкой, иначе вся она собирается в одном отрезке у пина
  let path = 0;
  for (let i = 1; i <= segments; i++) path += Math.hypot(points[i].ox - points[i - 1].ox, points[i].oy - points[i - 1].oy);
  state.stretch = Math.max(1, path / (rope.step * segments));
  const touching = new Set();
  const fresh = new Map();
  const lean = new Map();
  // «призраки» хранятся ключами пинов: номера и кластеры меняются при пересборке индекса
  const ghost = new Set();
  if (lasting) for (const list of candidates) for (const pin of list) if (state.ghost.has(pin.key)) ghost.add(clusterOf.get(pin.order));
  // закреплённый конец внутри пина: жгут не может держаться от этого пина дальше, чем сам конец,
  // поэтому зазор до него сжимается до расстояния от конца — плавно, вместе с концом
  const room = new Map();
  const ends = pinned ? [points[0], points[segments]] : [points[0]];
  for (const list of [candidates[0], candidates[segments - 1]]) {
    for (const pin of list) {
      for (const end of ends) {
        const distance = Math.hypot(end.x - pin.x, end.y - pin.y);
        if (distance < clearance) room.set(pin.key, Math.min(room.get(pin.key) ?? clearance, distance));
      }
    }
  }
  for (let segment = 0; segment < segments; segment++) {
    const start = points[segment];
    const end = points[segment + 1];
    const segX = end.ox - start.ox;
    const segY = end.oy - start.oy;
    const length = Math.hypot(segX, segY) || 1;
    for (const pin of candidates[segment]) {
      const cluster = clusterOf.get(pin.order);
      const reach = room.get(pin.key) ?? clearance;
      const pinX = pin.px !== undefined ? pin.px : pin.x;
      const pinY = pin.py !== undefined ? pin.py : pin.y;
      const across = (segX * (pinY - start.oy) - segY * (pinX - start.ox)) / length;
      const along = ((pinX - start.ox) * segX + (pinY - start.oy) * segY) / (length * length);
      const distance = along < 0 ? Math.hypot(pinX - start.ox, pinY - start.oy)
        : along > 1 ? Math.hypot(pinX - end.ox, pinY - end.oy) : Math.abs(across);
      if (distance < clearance) touching.add(cluster);
      // форма нового жгута — только догадка: пины, в которые она попала, он не трогает, пока из них не выйдет
      if (lasting && state.age < 2 && distance < clearance * DEEP) ghost.add(cluster);
      if (ghost.has(cluster)) continue;
      lean.set(cluster, (lean.get(cluster) || 0) + across);
      const contact = {pin, side: 0};
      if (reach < clearance) contact.clearance = reach;
      next[segment].push(contact);
      if (Math.abs(across) >= reach * DEEP || distance >= reach) {
        contact.side = Math.sign(across) || 1;
        continue;
      }
      contact.side = recall(memory, segment, pin.key);
      if (contact.side) continue;
      if (!fresh.has(cluster)) fresh.set(cluster, []);
      fresh.get(cluster).push(contact);
    }
  }
  for (const [cluster, list] of fresh) {
    const side = Math.sign(lean.get(cluster)) || 1;
    for (const contact of list) contact.side = side;
  }
  // призрак отпускает жгут, когда тот вышел из всех пинов кластера
  for (const cluster of ghost) if (!touching.has(cluster)) ghost.delete(cluster);
  state.ghost = new Set();
  for (const list of candidates) for (const pin of list) if (ghost.has(clusterOf.get(pin.order))) state.ghost.add(pin.key);
  if (ghost.size) for (const list of next) for (let i = list.length - 1; i >= 0; i--) if (ghost.has(clusterOf.get(list[i].pin.order))) list.splice(i, 1);
  // натяжение от конца меряет прямой: она верна, пока от конца до точки жгута видно — прямая не режет пин
  const obstacles = new Map();
  for (const list of next) for (const {pin} of list) obstacles.set(pin.order, pin);
  if (obstacles.size) {
    const blocked = (from, to) => {
      const segX = to.x - from.x;
      const segY = to.y - from.y;
      const lengthSquared = segX * segX + segY * segY || 1;
      for (const pin of obstacles.values()) {
        const t = Math.max(0, Math.min(1, ((pin.x - from.x) * segX + (pin.y - from.y) * segY) / lengthSquared));
        const reach = room.get(pin.key) ?? clearance;
        if (Math.hypot(from.x + segX * t - pin.x, from.y + segY * t - pin.y) < reach * SIGHT) return true;
      }
      return false;
    };
    for (let i = 1; i <= segments && state.seeStart === Infinity; i++) if (blocked(points[0], points[i])) state.seeStart = i - 1;
    if (pinned) for (let i = segments - 1; i >= 1 && state.seeEnd === -Infinity; i--) if (blocked(points[segments], points[i])) state.seeEnd = i + 1;
  }
  state.age++;
}

// Натяжение от концов: точка не дальше от закреплённого конца, чем шнур между
// ними (с растяжкой, если пины растянули жгут целиком). Прямая мерка верна, пока
// прямая от конца до точки не режет пин: за пином,
// который жгут огибает, путь вдоль жгута длиннее прямой, и натяжение тянуло бы жгут
// сквозь пины. Пин, к которому жгут просто прислонился, мерку не портит.
export function tetherRope(rope, pinned, startX, startY, endX, endY, slack = 0.996) {
  const points = rope.points;
  const last = points.length - 1;
  const state = rope.contact;
  const fromStart = state ? state.seeStart : Infinity;
  const fromEnd = state ? state.seeEnd : -Infinity;
  const reach = rope.step * slack * (state?.stretch || 1);
  const pull = (point, x, y, max) => {
    const dx = point.x - x;
    const dy = point.y - y;
    const distance = Math.hypot(dx, dy);
    if (distance > max && distance > 0) {
      point.x = x + dx * max / distance;
      point.y = y + dy * max / distance;
    }
  };
  for (let i = 1; i <= last; i++) {
    if (pinned && i === last) continue;
    if (i <= fromStart) pull(points[i], startX, startY, i * reach);
    if (pinned && i >= fromEnd) pull(points[i], endX, endY, (last - i) * reach);
  }
}

// Каждый проход солвера: вытолкнуть отрезки на их стороны до полного зазора.
// maxMove страхует от взрыва, если противоречие не решается за проход.
export function resolveRopeContacts(rope, pinned, clearance, options = {}) {
  const state = rope.contact;
  if (!state) return 0;
  const points = rope.points;
  const last = points.length - 1;
  const final = options.final === true;
  const maxMove = Number.isFinite(options.maxMove) ? options.maxMove : Infinity;
  let contacts = 0;
  const move = (point, dx, dy, repair, normalX, normalY) => {
    const shift = Math.hypot(dx, dy);
    if (shift > maxMove) {
      dx *= maxMove / shift;
      dy *= maxMove / shift;
    }
    point.x += dx;
    point.y += dy;
    // пин, в котором жгут был уже в начале кадра, — исправление положения, а не удар: скорость не растёт
    if (repair && final) {
      point.ox += dx;
      point.oy += dy;
    }
    point.contactX = normalX;
    point.contactY = normalY;
  };
  for (let segment = 0; segment < last; segment++) {
    const list = state.contacts[segment];
    if (!list || !list.length) continue;
    const start = points[segment];
    const end = points[segment + 1];
    const fixedStart = segment === 0;
    const fixedEnd = pinned && segment + 1 === last;
    const segX = end.x - start.x;
    const segY = end.y - start.y;
    const lengthSquared = segX * segX + segY * segY;
    if (lengthSquared < 1e-9) continue;
    const length = Math.sqrt(lengthSquared);
    for (const contact of list) {
      const {pin, side} = contact;
      const clear = contact.clearance ?? clearance;
      const along = ((pin.x - start.x) * segX + (pin.y - start.y) * segY) / lengthSquared;
      const pinX = pin.px !== undefined ? pin.px : pin.x;
      const pinY = pin.py !== undefined ? pin.py : pin.y;
      if (along < 0 || along > 1) {
        // вершину обслуживает отрезок, который в ней кончается
        if (along < 0 || fixedEnd) continue;
        const dx = end.x - pin.x;
        const dy = end.y - pin.y;
        const distance = Math.hypot(dx, dy);
        if (distance >= clear) continue;
        let normalX, normalY;
        if (distance > clear * DEEP) {
          normalX = dx / (distance || 1);
          normalY = dy / (distance || 1);
        } else {
          normalX = side * segY / length;
          normalY = -side * segX / length;
        }
        const push = clear - (normalX * dx + normalY * dy);
        const repair = Math.hypot(end.ox - pinX, end.oy - pinY) < clear - 1e-3;
        move(end, normalX * push, normalY * push, repair, normalX, normalY);
        contacts++;
        continue;
      }
      const gap = side * (segX * (pin.y - start.y) - segY * (pin.x - start.x)) / length;
      if (gap >= clear) continue;
      const normalX = side * segY / length;
      const normalY = -side * segX / length;
      const startWeight = fixedStart ? 0 : 1 - along;
      const endWeight = fixedEnd ? 0 : along;
      const denominator = startWeight * startWeight + endWeight * endWeight;
      if (denominator < 1e-9) continue;
      const lambda = (clear - gap) / denominator;
      const prevX = end.ox - start.ox;
      const prevY = end.oy - start.oy;
      const prevLength = Math.hypot(prevX, prevY) || 1;
      const repair = side * (prevX * (pinY - start.oy) - prevY * (pinX - start.ox)) / prevLength < clear - 1e-3;
      if (startWeight) move(start, normalX * lambda * startWeight, normalY * lambda * startWeight, repair, normalX, normalY);
      if (endWeight) move(end, normalX * lambda * endWeight, normalY * lambda * endWeight, repair, normalX, normalY);
      contacts++;
    }
  }
  return contacts;
}

// Конец кадра: контакт неупругий — скорость вдоль нормали пина гасится, вдоль
// поверхности остаётся с трением.
export function settleRopeContacts(rope, friction = 0.3) {
  for (const point of rope.points) {
    if (point.contactX === undefined) continue;
    let velocityX = point.x - point.ox;
    let velocityY = point.y - point.oy;
    const normal = velocityX * point.contactX + velocityY * point.contactY;
    velocityX -= normal * point.contactX;
    velocityY -= normal * point.contactY;
    point.ox = point.x - velocityX * (1 - friction);
    point.oy = point.y - velocityY * (1 - friction);
  }
}
