import { useRouter } from '@tanstack/react-router'
import { BrandName } from '~/components/brand'
import { LoginForm } from '~/components/login-form'
import { t } from '~/i18n'

export function LoginPage() {
  const router = useRouter()
  return (
    <main className="flex min-h-full flex-col items-center justify-center bg-ground px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-8">
          <BrandName />
        </div>
        <h1 className="mb-3 text-[22px] font-semibold leading-7">{t('login.title')}</h1>
        <p className="mb-8 text-sm text-muted">{t('login.warning')}</p>
        <LoginForm onSuccess={() => router.invalidate()} />
      </div>
    </main>
  )
}
