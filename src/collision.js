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
    const pin = {id, x, y, px, py, order: order++};
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
