export function findViolations(lock: { packages?: Record<string, { hasInstallScript?: boolean; version?: string }> }, allowed?: Record<string, string>): string[]
