import rateLimit from 'express-rate-limit';
import config from '../../config.js';

export function jsonRateLimit() {
  return rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.max,
    standardHeaders: true,
    legacyHeaders: true,
    handler: (req, res) => {
      const reset = req.rateLimit?.resetTime;
      const seconds = reset
        ? Math.max(1, Math.ceil((reset.getTime() - Date.now()) / 1000))
        : Math.ceil(config.rateLimit.windowMs / 1000);
      res.setHeader('Retry-After', String(seconds));
      res.status(429).json({
        error: { code: 'RATE_LIMITED', message: `Too many requests. Retry after ${seconds} second(s).` }
      });
    }
  });
}