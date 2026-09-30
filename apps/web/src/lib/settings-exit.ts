import type { RouterHistory } from '@tanstack/react-router'

// Settings is a mode, not a stack of pages. Back leaves settings in one step
// and returns to the page that opened it, however many settings pages the
// user visited in between.

const isSettingsPath = (pathname: string) => pathname.startsWith('/settings')

export type SettingsExitState = {
  /** The last page outside settings. */
  returnHref: string | null
  /** History index of the page that pushed settings, when known. */
  returnIndex: number | null
  inSettings: boolean
}

export function nextSettingsExit(
  state: SettingsExitState,
  location: { href: string; pathname: string; index: number },
  action: string,
): SettingsExitState {
  if (!isSettingsPath(location.pathname))
    return {
      returnHref: location.href,
      returnIndex: location.index,
      inSettings: false,
    }
  if (state.inSettings) return state
  // Entering settings. A push sits right after the page that opened it; a
  // reload or replace has no in-app page behind it to go back to.
  return {
    ...state,
    returnIndex:
      action === 'PUSH' && Number.isFinite(location.index)
        ? location.index - 1
        : null,
    inSettings: true,
  }
}

let state: SettingsExitState = {
  returnHref: null,
  returnIndex: null,
  inSettings: false,
}

export function trackSettingsExit(history: RouterHistory) {
  const update = (action: string) => {
    const { href, pathname, state: entry } = history.location
    state = nextSettingsExit(
      state,
      { href, pathname, index: entry.__TSR_index },
      action,
    )
  }
  update('REPLACE')
  return history.subscribe(({ action }) => update(action.type))
}

export function leaveSettings(history: RouterHistory) {
  const index = history.location.state.__TSR_index
  if (
    state.returnIndex !== null &&
    Number.isFinite(index) &&
    index > state.returnIndex
  ) {
    history.go(state.returnIndex - index)
    return
  }
  history.replace(state.returnHref ?? '/')
}
