import { ApiError } from '../lib/errors.js';

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No endpoint ${req.method} ${req.originalUrl}` }
  });
}

export function methodNotAllowedHandler(allowed) {
  return (req, res) => {
    res.setHeader('Allow', [...allowed].join(', '));
    res.status(405).json({
      error: { code: 'METHOD_NOT_ALLOWED', message: `${req.method} is not allowed for ${req.path}` }
    });
  };
}

export function errorHandler(err, req, res, _next) {
  if (err instanceof ApiError) {
    const body = { error: { code: err.code, message: err.message } };
    if (err.details) body.error.details = err.details;
    return res.status(err.status).json(body);
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'BODY_TOO_LARGE', message: 'Request body exceeds the 100kb limit' } });
  }
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side' } });
}
