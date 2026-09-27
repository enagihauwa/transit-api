import { createHash, randomBytes } from 'node:crypto';

export function makeId(prefix) {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

export function seedId(prefix, key) {
  return `${prefix}_${createHash('sha256').update(`${prefix}:${key}`).digest('hex').slice(0, 16)}`;
}

export function isValidId(prefix, value) {
  return typeof value === 'string' && new RegExp(`^${prefix}_[0-9a-f]{16}$`).test(value);
}

export function makeReference() {
  return `TVT-${randomBytes(3).toString('hex').toUpperCase()}`;
}