import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/audit/export/$token')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { handleAuditExport } = await import('../../../server/audit/http')
        return handleAuditExport(request, params.token)
      },
    },
  },
})
