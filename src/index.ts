import { createApp } from './app.ts';
import { config } from './config.ts';
import { db } from './db/index.ts';
import { provider } from './providers/index.ts';

const server = createApp().listen(config.port, () => {
  console.log(`ChatBotAI backend listening on http://localhost:${config.port}`);
  console.log(`  env      ${config.env}`);
  console.log(`  provider ${provider.name}`);
  console.log(`  database ${config.databasePath}`);
});

function shutdown(signal: string): void {
  console.log(`\n${signal} received, shutting down.`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
