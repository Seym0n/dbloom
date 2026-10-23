/**
 * Seam between the service layer (package C) and packages A and B of module sql-tab. Everything in
 * service.ts imports the runner, the explain/estimate functions and the redactor from here.
 */
export {
  runSqlText,
  confirmSqlRun,
  type SqlHistoryRecord as HistoryRecord,
  type SqlRunEnv,
} from './run'
export { cancelRun } from './registry'
export { explainSql, planAnalyse } from './explain'
export { estimateAffected } from './estimate'
export { resolveSqlLimits } from './limits'
export { redactSql } from '../../lib/sql/redact'
