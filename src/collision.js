import {hasTail} from './model.js';

const key = (x, y) => `${x},${y}`;

export function buildPinSpatialIndex(wires, cellSize) {
  const buckets = new Map();
  let order = 0;
  const add = (id, x, y) => {
    const bucketX = Math.floor(x / cellSize);
    const bucketY = Math.floor(y / cellSize);
    const bucketKey = key(bucketX, bucketY);
    const bucket = buckets.get(bucketKey) || [];
    bucket.push({id, x, y, order: order++});
    buckets.set(bucketKey, bucket);
  };
  for (const wire of wires) {
    add(wire.id, (wire.x + 0.5) * cellSize, (wire.y + 0.5) * cellSize);
    if (hasTail(wire)) add(wire.id, (wire.endX + 0.5) * cellSize, (wire.endY + 0.5) * cellSize);
  }
  return {cellSize, buckets, pinCount: order};
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
  return candidates;
}

function moveContact(point, dx, dy, normalX, normalY) {
  point.x += dx;
  point.y += dy;
  point.ox += dx;
  point.oy += dy;
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

export function resolveWirePinCollisions(wireId, points, pinned, index, clearance) {
  const last = points.length - 1;
  let contacts = 0;
  for (let segment = 0; segment < last; segment++) {
    const start = points[segment];
    const end = points[segment + 1];
    const fixedStart = segment === 0;
    const fixedEnd = pinned && segment + 1 === last;
    const pins = querySegmentPins(index, start, end, clearance, wireId);
    for (const pin of pins) {
      const segmentX = end.x - start.x;
      const segmentY = end.y - start.y;
      const lengthSquared = segmentX * segmentX + segmentY * segmentY || 1;
      const projection = Math.max(0, Math.min(1, ((pin.x - start.x) * segmentX + (pin.y - start.y) * segmentY) / lengthSquared));
      const nearX = start.x + segmentX * projection;
      const nearY = start.y + segmentY * projection;
      const deltaX = nearX - pin.x;
      const deltaY = nearY - pin.y;
      const distance = Math.hypot(deltaX, deltaY);
      if (distance >= clearance) continue;
      contacts++;
      const segmentLength = Math.sqrt(lengthSquared);
      const normalX = distance > 1e-6 ? deltaX / distance : (-segmentY / segmentLength || 1);
      const normalY = distance > 1e-6 ? deltaY / distance : (segmentX / segmentLength || 0);
      const push = clearance - distance;
      if (fixedStart && !fixedEnd) {
        moveContact(end, normalX * push, normalY * push, normalX, normalY);
      } else if (fixedEnd && !fixedStart) {
        moveContact(start, -normalX * push, -normalY * push, -normalX, -normalY);
      } else if (!fixedStart && !fixedEnd) {
        const half = push * 0.5;
        moveContact(start, -normalX * half, -normalY * half, -normalX, -normalY);
        moveContact(end, normalX * half, normalY * half, normalX, normalY);
      }
    }
  }
  return contacts;
}
