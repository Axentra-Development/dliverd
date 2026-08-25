import { buildApp } from './app.js';
import { makePool } from './db.js';

const pool = makePool();
const app = buildApp(pool);
const port = Number(process.env.PORT ?? 8787);
app.listen({ port, host: '0.0.0.0' }).then(() => {
  console.log(`custode api on :${port}`);
});
