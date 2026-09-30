import {
  canGenerateText,
  textGenerationHarnesses,
  type ForgeConfig,
  type TextModel,
} from '@forge/protocol/config'
import type { RolePolicy } from '@forge/protocol/rolePolicy'
import type { HarnessAccountStore } from '../accounts/store.js'
import { defaultRolePolicy } from '../config.js'
import type { TitleGenerator } from '../sessions/generated-titles.js'
import { titleFromReply, titleRequest } from '../sessions/titles.js'
import { generateText } from './generate.js'

/** Chat sessions use this until the user picks a title model. */
const defaultTitleModel: TextModel = { harness: 'claude-code-acp' }

/**
 * The model that titles a session. Chat sessions use the forge title model
 * from settings. Epic sessions use the epic role policy's title-generation
 * tier, so the epic runner keeps its own choice.
 */
export function titleModelFor(
  kind: string,
  settings: ForgeConfig['settings'],
): TextModel | undefined {
  if (kind !== 'epic_worker') return settings.titleModel ?? defaultTitleModel
  const policy: RolePolicy =
    settings.epicDefaults.rolePolicy ?? defaultRolePolicy
  const tier = policy.roles['title-generation']
  const hop = (tier ? policy.tiers[tier] : undefined)?.find((item) =>
    canGenerateText(item.harness),
  )
  return hop ? { harness: hop.harness, model: hop.model } : undefined
}

export function createTitleGenerator(options: {
  config: () => ForgeConfig
  accounts: HarnessAccountStore
}): TitleGenerator {
  return async ({ kind, current, messages }) => {
    const config = options.config()
    if (!config.settings.titleGeneration) return null
    const choice = titleModelFor(kind, config.settings)
    if (!choice || !canGenerateText(choice.harness)) return null
    const entry = config.harness[choice.harness]
    if (!entry?.enabled) return null
    const account = choice.accountId
      ? options.accounts.get(choice.accountId)
      : options.accounts
          .list(choice.harness)
          .find((item) => item.disabledAt === null)
    if (choice.accountId && account?.harnessKey !== choice.harness) return null
    const reply = await generateText({
      harness: choice.harness,
      entry,
      account: account ?? undefined,
      model:
        choice.model ?? textGenerationHarnesses[choice.harness].defaultModel,
      prompt: titleRequest(messages, current),
    })
    return titleFromReply(reply)
  }
}
