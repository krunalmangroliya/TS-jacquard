import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';

const port = Number(process.env.JDM_PORT ?? 4317);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('JDM_PORT must be a valid TCP port');
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const app = await createApp({ dataDir: path.resolve(projectRoot, process.env.JDM_DATA_DIR ?? 'data/jdm'), staticDir: path.resolve(projectRoot, process.env.JDM_STATIC_DIR ?? 'apps/web/dist'), logger: true });
await app.listen({ host: '127.0.0.1', port });
const close = async (): Promise<void> => { await app.close(); };
process.once('SIGINT', () => { void close(); }); process.once('SIGTERM', () => { void close(); });
