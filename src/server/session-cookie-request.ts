import { getRequestHeader } from '@tanstack/react-start/server'
import { sessionCookieName } from './session-cookie'

/** Session cookie name for the current server-function request (see `session-cookie.ts`). */
export const sessionCookie = (): string => sessionCookieName(getRequestHeader('host'))
