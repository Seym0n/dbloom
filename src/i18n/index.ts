import en from './en.json'

export type MessageKey = keyof typeof en

/** UI strings go through here so a second language is a new file, not a code change (NFR-TGT-160). */
export function t(key: MessageKey, values?: Record<string, string | number>): string {
  const template = en[key]
  if (!values) return template
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''))
}
