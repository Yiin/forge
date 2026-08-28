import type { HarnessAccountConfig } from '@forge/protocol/accounts'

export type AccountConfigField = {
  key: keyof HarnessAccountConfig
  control: 'text' | 'select' | 'password' | 'textarea' | 'switch'
  label: string
  description?: string
  placeholder?: string
  options?: readonly string[]
  clearWhenEmpty?: boolean
}

const thinkingLevels = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

export const ACCOUNT_CONFIG_FIELDS: Record<
  string,
  readonly AccountConfigField[]
> = {
  claude: [],
  codex: [],
  kimi: [],
  grok: [],
  opencode: [
    {
      key: 'provider',
      control: 'text',
      label: 'Provider',
      placeholder: 'Optional provider',
      clearWhenEmpty: true,
    },
    {
      key: 'model',
      control: 'text',
      label: 'Model',
      placeholder: 'Optional model',
      clearWhenEmpty: true,
    },
    {
      key: 'agent',
      control: 'text',
      label: 'Agent',
      placeholder: 'Optional agent',
      clearWhenEmpty: true,
    },
    {
      key: 'variant',
      control: 'text',
      label: 'Variant',
      placeholder: 'Optional variant',
      clearWhenEmpty: true,
    },
  ],
  pi: [
    {
      key: 'provider',
      control: 'text',
      label: 'Provider',
      placeholder: 'Optional provider',
      clearWhenEmpty: true,
    },
    {
      key: 'model',
      control: 'text',
      label: 'Model',
      placeholder: 'Optional model',
      clearWhenEmpty: true,
    },
    {
      key: 'thinking',
      control: 'select',
      label: 'Thinking',
      options: thinkingLevels,
    },
  ],
}

export function accountConfigFields(kind: string) {
  return ACCOUNT_CONFIG_FIELDS[kind] ?? []
}
