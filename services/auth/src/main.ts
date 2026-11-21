#!/usr/bin/env node
/**
 * picasso-auth.
 *
 *   OIDC_CLIENT_SECRET=... picasso-auth \
 *     --public-url https://picasso.example.com --oidc-issuer https://login.example.com \
 *     --client-id picasso-web --users users.json --tenants tenants.json --key session-key.jwk
 *
 * The provider sends the browser back to `<public-url>/auth/callback`, which
 * must be registered with it. `--key` holds the session-signing key as a
 * private JWK; without it a key is made at start, and every session ends when
 * the process does. To rotate it, restart with the new key as `--key` and the
 * old one as `--retired-key`: tokens it signed keep verifying, and new ones
 * are signed with the new key. Drop `--retired-key` fifteen minutes later.
 *
 * `--audit-pg` puts sign-ins and logouts on PRD 7.2's trail in Postgres
 * (`--audit-schema`, created with `--migrate`); without it the trail is in
 * this process's memory, for development.
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { MemoryAudit, migrateAudit, PostgresAudit, type AuditStore } from './audit.js';
import { Oidc } from './oidc.js';
import { startAuth } from './server.js';
import { SessionIssuer } from './sessions.js';

const { values } = parseArgs({
  options: {
    'public-url': { type: 'string' },
    'oidc-issuer': { type: 'string' },
    'client-id': { type: 'string' },
    users: { type: 'string' },
    tenants: { type: 'string' },
    key: { type: 'string' },
    'retired-key': { type: 'string', multiple: true },
    port: { type: 'string', default: '8770' },
    address: { type: 'string', default: '127.0.0.1' },
    'audit-pg': { type: 'string' },
    'audit-schema': { type: 'string', default: 'audit' },
    migrate: { type: 'boolean', default: false },
  },
});
for (const required of ['public-url', 'oidc-issuer', 'client-id', 'users', 'tenants'] as const) {
  if (!values[required]) {
    console.error(`--${required} is required`);
    process.exit(2);
  }
}
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const publicUrl = values['public-url']!.replace(/\/$/, '');
const issuer = await SessionIssuer.create({
  issuer: publicUrl,
  tenants: read(values.tenants!),
  ...(values.key ? { privateJwk: read(values.key) } : {}),
  ...(values['retired-key'] ? { retiredJwks: values['retired-key'].map(read) } : {}),
});
const oidc = new Oidc({
  issuer: values['oidc-issuer']!,
  clientId: values['client-id']!,
  ...(process.env.OIDC_CLIENT_SECRET ? { clientSecret: process.env.OIDC_CLIENT_SECRET } : {}),
  redirectUri: `${publicUrl}/auth/callback`,
});
let audit: AuditStore;
if (values['audit-pg']) {
  const pool = new pg.Pool({ connectionString: values['audit-pg'] });
  if (values.migrate) await migrateAudit(pool, values['audit-schema']!);
  audit = new PostgresAudit(pool, values['audit-schema']!);
} else {
  console.error('no --audit-pg: sign-ins are recorded in memory only');
  audit = new MemoryAudit();
}
const { url } = await startAuth({ oidc, issuer, users: read(values.users!), secure: publicUrl.startsWith('https:'), audit }, Number(values.port), values.address);
console.error(`picasso-auth listening on ${url}, issuing for ${publicUrl}`);
