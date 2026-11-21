/**
 * PRD 7.2's audit trail, written from TypeScript. The module is picasso-auth's
 * (`services/auth/src/audit.ts`), since sign-ins are recorded there and this
 * package depends on that one; exports are recorded here through the same code.
 */

export { checkPurpose, DEFAULT_RETENTION_DAYS, MemoryAudit, migrateAudit, PostgresAudit, traceId, type AuditRecord, type AuditStore } from '@picasso/auth';
