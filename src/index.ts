import { createApp } from './app.ts';
import { config } from './config.ts';
import { db } from './db/index.ts';
import { provider } from './providers/index.ts';
import { purgeExpiredSessions } from './db/users.ts';

const purged = purgeExpiredSessions();

// Boot-time purge alone leaves a long-running instance to accumulate expired
// rows; a periodic sweep keeps the table small. unref so it never holds the
// process open during shutdown.
const sweep = setInterval(() => {
  const count = purgeExpiredSessions();
  if (count > 0) console.log(`purged ${count} expired session(s)`);
}, config.sessionSweepMs);
sweep.unref();

const server = createApp().listen(config.port, () => {
  console.log(`ChatBotAI backend listening on http://localhost:${config.port}`);
  console.log(`  env      ${config.env}`);
  console.log(`  provider ${provider.name}`);
  console.log(`  database ${config.databasePath}`);
  if (purged > 0) console.log(`  purged   ${purged} expired session(s)`);
});

function shutdown(signal: string): void {
  console.log(`\n${signal} received, shutting down.`);
  clearInterval(sweep);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
