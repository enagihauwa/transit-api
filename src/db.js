import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import config from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined
});

pool.on('error', (err) => {
  console.error('[transit-api] idle postgres client error', err);
});

function toPositional(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function makeFacade(execute) {
  return {
    async get(text, ...params) {
      const { rows } = await execute(toPositional(text), params);
      return rows[0];
    },
    async all(text, ...params) {
      const { rows } = await execute(toPositional(text), params);
      return rows;
    },
    async run(text, ...params) {
      const { rowCount } = await execute(toPositional(text), params);
      return { changes: rowCount ?? 0 };
    },
    async exec(text) {
      await execute(text, []);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(makeFacade((sql, params) => client.query(sql, params)));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }
  };
}

const db = makeFacade((sql, params) => pool.query(sql, params));

export async function countRows(table) {
  const row = await db.get(`SELECT COUNT(*) AS c FROM ${table}`);
  return Number(row.c);
}

export async function initSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

export default db;