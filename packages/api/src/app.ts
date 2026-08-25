import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireAuth } from './auth.js';
import { packingRoutes } from './routes/packing.js';

export function buildApp(pool: pg.Pool): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get('/health', async () => ({ ok: true }));
  app.addHook('preHandler', async (req, reply) => {
    if (req.url === '/health') return;
    return requireAuth(pool)(req, reply);
  });
  packingRoutes(app, pool);
  return app;
}
