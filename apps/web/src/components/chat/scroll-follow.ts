/**
 * Follow-bottom rules after zeron (crates/ui/src/transcript.rs). The view
 * starts pinned; while pinned, new content keeps it at the bottom. Only real
 * user input may release the pin, never content growth.
 */
export const AT_BOTTOM_PX = 2
export const STICK_THRESHOLD_PX = 70
export const JUMP_SHOW_PX = 320

export type FollowState = {
  pinned: boolean
  /** Whether the "Scroll to bottom" pill shows. */
  jump: boolean
  /** Distance from the bottom at the last scroll event. */
  distance: number
}

export const initialFollow: FollowState = {
  pinned: true,
  jump: false,
  distance: 0,
}

export function distanceFromBottom(node: {
  scrollHeight: number
  clientHeight: number
  scrollTop: number
}) {
  return Math.max(0, node.scrollHeight - node.clientHeight - node.scrollTop)
}

/**
 * The next state after a scroll event. `userInput` says a wheel, touch, key
 * or scrollbar drag caused the scroll.
 */
export function followAfterScroll(
  state: FollowState,
  distance: number,
  userInput: boolean,
): FollowState {
  let pinned = state.pinned
  if (pinned) {
    // Break follow: the user moved away from the bottom.
    if (userInput && distance > state.distance + 1 && distance > AT_BOTTOM_PX)
      pinned = false
  } else if (
    distance <= AT_BOTTOM_PX ||
    // Re-stick inside the band only while moving down, so a small wheel-up
    // near the bottom does not snap back.
    (distance <= STICK_THRESHOLD_PX && distance < state.distance)
  )
    pinned = true
  return { pinned, jump: jumpVisible(state.jump, pinned, distance), distance }
}

/** Release the pin on purpose, such as for a rail jump or a deep link. */
export function releaseFollow(state: FollowState): FollowState {
  return { ...state, pinned: false }
}

/** Pin again, such as after a send or the jump pill. */
export function restoreFollow(state: FollowState): FollowState {
  return { ...state, pinned: true, jump: false }
}

/**
 * The pill has hysteresis: it appears past 320px and stays until the view
 * is back within 2px of the bottom.
 */
export function jumpVisible(shown: boolean, pinned: boolean, distance: number) {
  if (pinned) return false
  if (!shown) return distance > JUMP_SHOW_PX
  return distance > AT_BOTTOM_PX
}

/**
 * The pill click teleports to 2.5 viewports from the end before gliding, so
 * a long way back does not take seconds.
 */
export function jumpStart(distance: number, viewport: number, max: number) {
  const limit = viewport * 2.5
  return distance > limit ? max - limit : undefined
}
