import {
  ArrowDown,
  ArrowUp,
  Ban,
  CircleCheck,
  LogIn,
  LogOut,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  SlidersHorizontal,
  TimerReset,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from '@/components/ui/menu'
import { accountConfigFields } from '@/lib/account-config-fields'
import type { AccountRowModel } from './accounts-settings-logic'
import { RedactedSensitiveText } from './RedactedSensitiveText'
import { SettingsCardRow, SettingsMeta, UsageMeter } from './settings-layout'
import { formatResetText } from './settings-widgets-logic'

export type AccountRowAction =
  | 'switch'
  | 'sign-in'
  | 'sign-out'
  | 'rename'
  | 'model'
  | 'clear-cooldown'
  | 'refresh-usage'
  | 'move-up'
  | 'move-down'
  | 'toggle-enabled'
  | 'delete'

const pill =
  'rounded-full px-2 py-0.5 text-[10.5px] leading-4 whitespace-nowrap'

/**
 * One account: initial avatar, email (or name) with status and usage meters,
 * then pills over the Switch / Sign in / More actions on the right.
 */
export function AccountRow({
  row,
  index,
  count,
  busy,
  nowMs,
  onAction,
}: {
  row: AccountRowModel
  index: number
  count: number
  /** The action in flight for this row, if any. */
  busy: AccountRowAction | null
  nowMs: number
  onAction: (action: AccountRowAction) => void
}) {
  const limitReset = row.limit?.resetsAt
    ? formatResetText(row.limit.resetsAt, nowMs)
    : null
  const canSignIn = row.authAction.kind === 'sign-in'
  const disabledActions = busy !== null
  return (
    <SettingsCardRow
      dimmed={row.disabled}
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-0"
      data-account-id={row.id}
    >
      <div
        aria-hidden
        className="grid size-8 shrink-0 place-items-center self-center rounded-full border bg-muted/40 text-xs font-semibold text-muted-foreground sm:row-span-2"
      >
        {row.initial}
      </div>
      <div className="min-w-0 self-center">
        <div className="truncate text-[13px] font-medium">
          {row.email ? (
            <RedactedSensitiveText
              value={row.email}
              ariaLabel={`Toggle ${row.label} email visibility`}
              revealTooltip="Click to reveal email"
              hideTooltip="Click to hide email"
            />
          ) : (
            row.label
          )}
        </div>
        <SettingsMeta>
          {row.email && row.label !== row.email && (
            <span className="truncate">{row.label}</span>
          )}
          {row.disabled && <span>Disabled</span>}
          {!row.signedIn && <span className="text-warning">Not signed in</span>}
          {row.authAction.kind === 'manual' && row.authAction.command && (
            <span>
              Run{' '}
              <code className="break-all text-foreground/80">
                {row.authAction.command}
              </code>{' '}
              on the server to sign in
            </span>
          )}
          {row.limit && <span className="text-warning">{row.limit.label}</span>}
          {limitReset && <span className="text-warning">{limitReset}</span>}
        </SettingsMeta>
      </div>
      <div className="col-start-3 row-start-1 flex shrink-0 flex-col items-end justify-between gap-2 self-stretch sm:row-span-2">
        <div className="flex items-center gap-1.5">
          {row.active && (
            <span className={`${pill} bg-success/12 text-success-foreground`}>
              Active
            </span>
          )}
          {row.plan && (
            <span className={`${pill} border text-muted-foreground`}>
              {row.plan}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {row.switchable && (
            <Button
              size="xs"
              className="px-2 text-[11.5px] sm:h-6 sm:text-[11.5px]"
              disabled={disabledActions}
              onClick={() => onAction('switch')}
            >
              {busy === 'switch' ? 'Switching…' : 'Switch'}
            </Button>
          )}
          {canSignIn && (
            <Button
              size="xs"
              variant="ghost"
              className="px-2 text-[11.5px] text-muted-foreground sm:h-6 sm:text-[11.5px]"
              disabled={disabledActions}
              onClick={() => onAction('sign-in')}
            >
              {busy === 'sign-in' ? 'Starting…' : 'Sign in'}
            </Button>
          )}
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="text-muted-foreground"
                  aria-label={`More actions for ${row.label}`}
                  disabled={disabledActions}
                />
              }
            >
              <MoreHorizontal />
            </MenuTrigger>
            <MenuPopup align="end" className="min-w-44">
              <MenuItem onClick={() => onAction('rename')}>
                <Pencil />
                Rename…
              </MenuItem>
              {accountConfigFields(row.kind).length > 0 && (
                <MenuItem onClick={() => onAction('model')}>
                  <SlidersHorizontal />
                  Model settings…
                </MenuItem>
              )}
              {canSignIn && (
                <MenuItem onClick={() => onAction('sign-in')}>
                  <LogIn />
                  Sign in
                </MenuItem>
              )}
              {row.authAction.kind === 'sign-out' && (
                <MenuItem onClick={() => onAction('sign-out')}>
                  <LogOut />
                  Sign out…
                </MenuItem>
              )}
              {row.limit && (
                <MenuItem onClick={() => onAction('clear-cooldown')}>
                  <TimerReset />
                  Clear cooldown
                </MenuItem>
              )}
              {row.signedIn && (
                <MenuItem onClick={() => onAction('refresh-usage')}>
                  <RefreshCw />
                  Refresh usage
                </MenuItem>
              )}
              {index > 0 && (
                <MenuItem onClick={() => onAction('move-up')}>
                  <ArrowUp />
                  Move up
                </MenuItem>
              )}
              {index < count - 1 && (
                <MenuItem onClick={() => onAction('move-down')}>
                  <ArrowDown />
                  Move down
                </MenuItem>
              )}
              <MenuItem onClick={() => onAction('toggle-enabled')}>
                {row.disabled ? <CircleCheck /> : <Ban />}
                {row.disabled ? 'Enable' : 'Disable'}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                variant="destructive"
                onClick={() => onAction('delete')}
              >
                <Trash2 />
                Delete…
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </div>
      {/* Phones give the meters the full row width below the avatar. */}
      {row.signedIn &&
        (row.usage.length > 0 ? (
          <div className="col-span-3 mt-1.5 flex min-w-0 flex-col gap-1 sm:col-span-1 sm:col-start-2">
            {row.usage.map((window) => (
              <UsageMeter
                key={window.id}
                label={window.label}
                percent={window.percent}
                resetsAt={window.resetsAt}
                nowMs={nowMs}
              />
            ))}
          </div>
        ) : (
          <p className="col-span-3 mt-1.5 truncate text-[11.5px] text-muted-foreground sm:col-span-1 sm:col-start-2">
            Usage unavailable
          </p>
        ))}
    </SettingsCardRow>
  )
}
