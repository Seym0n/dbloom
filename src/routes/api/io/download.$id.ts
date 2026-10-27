import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/io/download/$id')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const [{ getRuntime }, { handleIoDownload }] = await Promise.all([
          import('../../../server/runtime'),
          import('../../../server/io/http'),
        ])
        return handleIoDownload(request, params.id, getRuntime())
      },
    },
  },
})
