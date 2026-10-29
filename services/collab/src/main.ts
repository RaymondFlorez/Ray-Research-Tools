#!/usr/bin/env node
/**
 * picasso-collab.
 *
 *   picasso-collab --pg postgres://... --users ../dataplane/config/users.json \
 *                  [--schema collab] [--migrate] [--port 8760] [--address 127.0.0.1]
 *
 * Users name themselves with their token, the development stand-in for an
 * identity provider that the data plane and the gateway also use, so it
 * listens on loopback by default.
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { startCollab, type Users } from './server.js';
import { migrate } from './store.js';

const { values } = parseArgs({
  options: {
    pg: { type: 'string' },
    users: { type: 'string' },
    schema: { type: 'string', default: 'collab' },
    migrate: { type: 'boolean', default: false },
    port: { type: 'string', default: '8760' },
    address: { type: 'string', default: '127.0.0.1' },
    'auth-url': { type: 'string' },
    'dev-identity': { type: 'boolean', default: false },
  },
});
if (!values.pg || !values.users) {
  console.error('--pg and --users are required');
  process.exit(2);
}
const users = JSON.parse(readFileSync(values.users, 'utf8')) as Users;
const pool = new pg.Pool({ connectionString: values.pg });
if (values.migrate) await migrate(pool, values.schema);
const collab = await startCollab({
  pool, schema: values.schema, users, port: Number(values.port), address: values.address,
  ...(values['auth-url'] ? { authUrl: values['auth-url'] } : {}), devIdentity: values['dev-identity'],
});
console.error(`picasso-collab listening on ${collab.url}`);
const stop = async () => {
  await collab.destroy();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
