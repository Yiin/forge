import { describe, expect, it } from 'vitest'
import { nextSettingsExit, type SettingsExitState } from './settings-exit'

const start: SettingsExitState = {
  returnHref: null,
  returnIndex: null,
  inSettings: false,
}
const at = (href: string, index: number) => ({
  href,
  pathname: href.split('?')[0]!,
  index,
})

describe('nextSettingsExit', () => {
  it('returns to the page that pushed settings, past every settings page', () => {
    let state = nextSettingsExit(start, at('/s/abc', 4), 'PUSH')
    state = nextSettingsExit(state, at('/settings/general', 5), 'PUSH')
    state = nextSettingsExit(state, at('/settings/agents', 6), 'PUSH')
    state = nextSettingsExit(state, at('/settings/epics', 6), 'REPLACE')
    expect(state).toEqual({
      returnHref: '/s/abc',
      returnIndex: 4,
      inSettings: true,
    })
  })
  it('has no page to go back to when settings loads first', () => {
    const state = nextSettingsExit(start, at('/settings/general', 0), 'REPLACE')
    expect(state.returnIndex).toBeNull()
    expect(state.returnHref).toBeNull()
  })
})
