/** Step logic of the setup wizard (FR-AUT-003, UI-TGT-002): which steps apply and how to move between them. */
import type { LoginMode, SetupStep } from '~/server/auth/types'

export const WIZARD_STEPS = ['welcome', 'mode', 'site', 'admin', 'done'] as const
export type WizardStep = (typeof WIZARD_STEPS)[number]

/** Direct mode has no DBLoom users, so step 4 is skipped. */
export function applicableSteps(mode: LoginMode | undefined): WizardStep[] {
  return mode === 'direct' ? ['welcome', 'mode', 'site', 'done'] : [...WIZARD_STEPS]
}

export function stepNumber(step: WizardStep): SetupStep {
  return (WIZARD_STEPS.indexOf(step) + 1) as SetupStep
}

export function nextStep(step: WizardStep, mode: LoginMode | undefined): WizardStep {
  const list = applicableSteps(mode)
  return list[Math.min(list.indexOf(step) + 1, list.length - 1)] ?? step
}

export function previousStep(step: WizardStep, mode: LoginMode | undefined): WizardStep {
  const list = applicableSteps(mode)
  return list[Math.max(list.indexOf(step) - 1, 0)] ?? step
}

export type AdminProgress = { passwordSet: boolean; hasFactor: boolean; codesPending: boolean; codesSaved: boolean }

/** Step 4 may finish once a password and a factor exist and any recovery codes were saved. */
export function adminComplete(p: AdminProgress): boolean {
  return p.passwordSet && p.hasFactor && (!p.codesPending || p.codesSaved)
}

export const msToHours = (ms: number) => Math.round((ms / 3_600_000) * 100) / 100
export const hoursToMs = (hours: number) => Math.round(hours * 3_600_000)
export const msToMinutes = (ms: number) => Math.round(ms / 60_000)
export const minutesToMs = (minutes: number) => Math.round(minutes * 60_000)
export const msToDays = (ms: number) => Math.round((ms / 86_400_000) * 100) / 100
export const daysToMs = (days: number) => Math.round(days * 86_400_000)
