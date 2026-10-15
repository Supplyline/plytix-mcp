import { createRequire } from 'node:module';

/**
 * The server version, read from package.json at startup. It used to be a hand-edited constant
 * that stayed at 0.3.3 through 0.4.0, so `serverInfo.version` could not tell a stale build from a
 * current one.
 */
const require = createRequire(import.meta.url);
export const VERSION: string = (require('../package.json') as { version: string }).version;
