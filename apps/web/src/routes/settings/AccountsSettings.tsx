import { SettingsPage } from '../../components/settings/settings-layout'

export function AccountsSettings() {
  return (
    <SettingsPage
      title="Accounts"
      subtitle="Signed-in accounts for each agent. Every account keeps its own credentials on this server. New sessions use the active account, and Forge moves to the next account when one hits a limit."
    >
      <p className="text-[13px] text-muted-foreground">Coming next</p>
    </SettingsPage>
  )
}
