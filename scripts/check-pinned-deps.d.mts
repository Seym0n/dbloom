export function findUnpinned(
  pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> },
  lock: { packages?: Record<string, { version?: string }> },
): string[]
