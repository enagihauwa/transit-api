import express from 'express';
import morgan from 'morgan';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config.js';
import apiRouter from './routes.js';
import { jsonRateLimit } from './middleware/rate-limit.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

if (config.trustProxy) {
  app.set('trust proxy', 1);
}

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '100kb' }));

app.get('/health', (req, res) => {
  res.json({
    data: {
      status: 'ok',
      version: 'v1',
      time: new Date().toISOString()
    }
  });
});

app.use('/api/v1', jsonRateLimit(), apiRouter);
app.use('/api/v1', notFoundHandler);

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(notFoundHandler);

app.use(errorHandler);

export default app;