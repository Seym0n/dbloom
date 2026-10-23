import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['.output/**', 'node_modules/**', 'legacy-release/**', 'src/routeTree.gen.ts', 'SPEC/**', '.claude/**', '.agents/**', 'test-results/**'] },
  ...tseslint.configs.recommended,
)
