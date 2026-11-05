import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['.output/**', 'node_modules/**', 'src/routeTree.gen.ts', 'SPEC/**', '.claude/**', '.agents/**', 'test-results/**', 'docs/**', 'docs-temp/**', '.taste-skill/**'] },
  ...tseslint.configs.recommended,
  {
    // FR-SVR-005: one module decides client address, scheme and host. Nothing else reads forwarded headers.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/server/net/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['@tanstack/react-start/server', '@tanstack/start-server-core', 'h3'].map((name) => ({
            name,
            importNames: ['getRequestIP', 'getRequestHost', 'getRequestProtocol', 'getRequestUrl'],
            message: 'Use src/server/net (currentClientAddress, currentRequestOrigin); forwarded headers are read only there (FR-SVR-005).',
          })),
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/^(x-forwarded-|x-real-ip$|forwarded$|cf-connecting-ip$|true-client-ip$)/i]',
          message: 'Forwarded headers are read only in src/server/net (FR-SVR-005).',
        },
      ],
    },
  },
)
