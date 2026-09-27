import db from '../db.js';
import config from '../../config.js';
import { ApiError } from './errors.js';
import { isValidId } from './ids.js';

function decodeCursor(raw) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string') return null;
  return parsed;
}

function encodeCursor(row, rule, field) {
  const value = row[field];
  return Buffer.from(
    JSON.stringify({
      sortValue: rule.type === 'number' ? Number(value) : String(value),
      id: row.id
    }),
    'utf8'
  ).toString('base64url');
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (m) => `\\${m}`);
}

function coerceFilter(value, def) {
  if (def.enum) {
    if (!def.enum.includes(value)) {
      throw new ApiError(400, 'INVALID_FILTER', `Invalid value "${value}" for filter "${def.param}". Allowed: ${def.enum.join(', ')}`);
    }
    return value;
  }
  if (def.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      throw new ApiError(400, 'INVALID_FILTER', `Filter "${def.param}" expects a number, got "${value}"`);
    }
    return n;
  }
  if (def.coerce) {
    return def.coerce(value, def);
  }
  return value;
}

function readPagination(req) {
  const { defaultLimit, maxLimit } = config.pagination;

  let limit = defaultLimit;
  if (req.query.limit !== undefined) {
    const n = Number(req.query.limit);
    if (!Number.isInteger(n) || n < 1) {
      throw new ApiError(400, 'INVALID_QUERY', `limit must be a positive integer, got "${req.query.limit}"`);
    }
    limit = Math.min(n, maxLimit);
  }

  let offset = 0;
  if (req.query.offset !== undefined) {
    const n = Number(req.query.offset);
    if (!Number.isInteger(n) || n < 0) {
      throw new ApiError(400, 'INVALID_QUERY', `offset must be a non-negative integer, got "${req.query.offset}"`);
    }
    offset = n;
  }

  let cursor = null;
  if (req.query.cursor !== undefined) {
    cursor = decodeCursor(req.query.cursor);
    if (!cursor) {
      throw new ApiError(400, 'INVALID_CURSOR', 'cursor is malformed');
    }
  }

  if (offset > 0 && cursor) {
    throw new ApiError(400, 'INVALID_QUERY', 'Use either offset or cursor, not both');
  }

  return { limit, offset, cursor };
}

export function createListHandler({
  table,
  select,
  join = '',
  orderFields,
  defaultOrderField = 'created_at',
  defaultOrderDir = 'desc',
  filters = [],
  baseWhere = null,
  idColumn = 'id',
  transform = (rows) => rows
}) {
  const fieldNames = Object.keys(orderFields);

  function listHandler(req, res, next) {
    runList(req, res).catch(next);
  }

  async function runList(req, res) {
    const { limit, offset, cursor } = readPagination(req);

    let orderField = defaultOrderField;
    if (req.query.sort !== undefined) {
      if (!(req.query.sort in orderFields)) {
        throw new ApiError(400, 'INVALID_SORT', `Unknown sort field "${req.query.sort}". Allowed: ${fieldNames.join(', ')}`);
      }
      orderField = req.query.sort;
    }

    let orderDir = defaultOrderDir;
    if (req.query.order !== undefined) {
      if (req.query.order !== 'asc' && req.query.order !== 'desc') {
        throw new ApiError(400, 'INVALID_ORDER', `order must be "asc" or "desc", got "${req.query.order}"`);
      }
      orderDir = req.query.order;
    }

    const rule = orderFields[orderField];
    const dirSql = orderDir === 'asc' ? 'ASC' : 'DESC';

    const where = [];
    const params = [];
    for (const f of filters) {
      if (req.query[f.param] === undefined) continue;
      const value = coerceFilter(req.query[f.param], f);
      const op = f.op || 'eq';
      if (op === 'like') {
        where.push(`${f.column} LIKE ? ESCAPE '\\'`);
        params.push(`%${escapeLike(value)}%`);
      } else if (op === 'gte') {
        where.push(`${f.column} >= ?`);
        params.push(value);
      } else if (op === 'lte') {
        where.push(`${f.column} <= ?`);
        params.push(value);
      } else {
        where.push(`${f.column} = ?`);
        params.push(value);
      }
    }
    if (baseWhere) {
      where.push(baseWhere.sql);
      params.push(...baseWhere.params);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const totalRow = await db.get(`SELECT COUNT(*) AS c FROM ${table} ${whereSql}`, ...params);
    const total = Number(totalRow.c);

    let rows;
    let hasMore;
    let nextCursor = null;

    if (cursor) {
      let sortValue = cursor.sortValue;
      if (rule.type === 'number') {
        if (typeof sortValue !== 'number' || !Number.isFinite(sortValue)) {
          throw new ApiError(400, 'INVALID_CURSOR', 'Cursor is not valid for the requested sort');
        }
      } else if (typeof sortValue !== 'string') {
        throw new ApiError(400, 'INVALID_CURSOR', 'Cursor is not valid for the requested sort');
      }

      const rel = dirSql === 'ASC' ? '>' : '<';
      const keyset = `((${rule.column} ${rel} ?) OR (${rule.column} = ? AND ${idColumn} ${rel} ?))`;
      const sql = `SELECT ${select} FROM ${table} ${join} ${whereSql} ${whereSql ? 'AND' : 'WHERE'} ${keyset} ORDER BY ${rule.column} ${dirSql}, ${idColumn} ${dirSql} LIMIT ?`;
      const raw = await db.all(sql, ...params, sortValue, sortValue, cursor.id, limit + 1);
      hasMore = raw.length > limit;
      rows = raw.slice(0, limit);
      if (hasMore) {
        nextCursor = encodeCursor(rows[rows.length - 1], rule, orderField);
      }
    } else {
      const sql = `SELECT ${select} FROM ${table} ${join} ${whereSql} ORDER BY ${rule.column} ${dirSql}, ${idColumn} ${dirSql} LIMIT ? OFFSET ?`;
      rows = await db.all(sql, ...params, limit, offset);
      hasMore = offset + limit < total;
      if (hasMore) {
        nextCursor = encodeCursor(rows[rows.length - 1], rule, orderField);
      }
    }

    res.json({ data: transform(rows), meta: { total, limit, offset, hasMore, ...(nextCursor ? { nextCursor } : {}) } });
  }

  return listHandler;
}

export function createItemHandler({ resourceName, table, idPrefix, select, join = '', idColumn = 'id', transform = (row) => row }) {
  function itemHandler(req, res, next) {
    runItem(req, res).catch(next);
  }

  async function runItem(req, res) {
    const { id } = req.params;
    if (!isValidId(idPrefix, id)) {
      throw new ApiError(400, 'INVALID_ID', `Malformed "${idPrefix}_" identifier: ${id}`);
    }
    const row = await db.get(`SELECT ${select} FROM ${table} ${join} WHERE ${idColumn} = ?`, id);
    if (!row) {
      throw new ApiError(404, 'NOT_FOUND', `${resourceName} not found`);
    }
    res.json({ data: transform(row) });
  }

  return itemHandler;
}