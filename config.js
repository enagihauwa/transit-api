const env = process.env;

export default {
  host: env.HOST || '0.0.0.0',
  port: Number(env.PORT || 8080),
  databaseUrl: env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/transit',
  databaseSsl: env.DATABASE_SSL === 'true' ? true : false,
  trustProxy: env.TRUST_PROXY ? env.TRUST_PROXY === 'true' : env.NODE_ENV === 'production',
  pagination: {
    defaultLimit: Number(env.DEFAULT_LIMIT || 20),
    maxLimit: Number(env.MAX_LIMIT || 100)
  },
  rateLimit: {
    windowMs: Number(env.RATE_LIMIT_WINDOW_MS || 60_000),
    max: Number(env.RATE_LIMIT_MAX || 100)
  },
  seed: {
    value: Number(env.SEED_VALUE || 20241809),
    stops: Number(env.SEED_STOPS || 300),
    routes: Number(env.SEED_ROUTES || 300),
    vehicles: Number(env.SEED_VEHICLES || 300),
    bookings: Number(env.SEED_BOOKINGS || 800),
    skipAtBoot: env.SEED_SKIP_AT_BOOT === 'true'
  }
};