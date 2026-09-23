import { SettingsPage } from '../../components/settings/settings-layout'

export function AgentsSettings() {
  return (
    <SettingsPage
      title="Agents"
      subtitle="Choose which coding agents the composer offers. Agents whose CLI isn't installed on this server can't be enabled."
    >
      <p className="text-[13px] text-muted-foreground">Coming next</p>
    </SettingsPage>
  )
}
