import { readFileSync } from 'node:fs';
import { ConfigError, readConfig } from './config.js';
import { createHttpServer } from './http.js';
import { OpenCloud } from './opencloud.js';
import { extractText } from './tika.js';
import { createToolServer } from './tools.js';

const log = (fields: Record<string, unknown>) => { process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...fields })}\n`); };

let config;
try { config = readConfig(process.env); } catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  log({ level: 'error', event: 'startup_failed', message: error.message });
  process.exit(1);
}
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const openCloud = new OpenCloud(config);
const tikaUrl = config.tikaUrl;
const server = createHttpServer(() => createToolServer({ openCloud, config, version, log,
  ...(tikaUrl ? { extract: (bytes, contentType) => extractText(tikaUrl, bytes, contentType) } : {}) }), config.mcpToken);
server.listen(config.port, config.host, () => log({ level: 'info', event: 'listening', host: config.host, port: config.port }));
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); });
}
