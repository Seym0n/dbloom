import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/rows/upload')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const [{ getRuntime }, { handleUpload }] = await Promise.all([
          import('../../../server/runtime'),
          import('../../../server/rows/http'),
        ])
        return handleUpload(request, getRuntime())
      },
    },
  },
})
