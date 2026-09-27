import config from '../config.js';
import app from './app.js';
import { initSchema } from './db.js';
import { ensureSeeded } from './seed.js';

async function start() {
  await initSchema();
  await ensureSeeded();

  const server = app.listen(config.port, config.host, () => {
    console.log(`[transit-api] listening on http://${config.host}:${config.port}`);
    console.log(`[transit-api] base URL        http://localhost:${config.port}/api/v1`);
    console.log(`[transit-api] health check    http://localhost:${config.port}/health`);
  });

  function shutdown() {
    server.close(() => process.exit(0));
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((err) => {
  console.error('[transit-api] failed to start', err);
  process.exit(1);
});