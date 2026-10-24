import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/rows/cell/$id')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const [{ getRuntime }, { handleCellGet }] = await Promise.all([
          import('../../../server/runtime'),
          import('../../../server/rows/http'),
        ])
        return handleCellGet(request, params.id, getRuntime())
      },
    },
  },
})
