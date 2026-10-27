import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/io/upload')({
  server: {
    handlers: {
      PUT: async ({ request }) => {
        const [{ getRuntime }, { handleIoUpload }] = await Promise.all([
          import('../../../server/runtime'),
          import('../../../server/io/http'),
        ])
        return handleIoUpload(request, getRuntime())
      },
    },
  },
})
