import { describe, expect, it } from 'vitest'
import {
  distanceFromBottom,
  followAfterScroll,
  initialFollow,
  jumpStart,
  jumpVisible,
  releaseFollow,
  restoreFollow,
} from './scroll-follow'

const pinned = initialFollow
const released = { pinned: false, jump: false, distance: 200 }

describe('scroll follow', () => {
  it('measures the distance from the bottom', () => {
    expect(
      distanceFromBottom({
        scrollHeight: 1000,
        clientHeight: 400,
        scrollTop: 500,
      }),
    ).toBe(100)
  })

  it('releases the pin only for user input moving away from the bottom', () => {
    expect(followAfterScroll(pinned, 40, true).pinned).toBe(false)
    // Content growth never unpins.
    expect(followAfterScroll(pinned, 400, false).pinned).toBe(true)
    // A 1px wobble or a stop within 2px keeps the pin.
    expect(followAfterScroll(pinned, 1, true).pinned).toBe(true)
    expect(
      followAfterScroll({ ...pinned, distance: 30 }, 31, true).pinned,
    ).toBe(true)
  })

  it('re-sticks at the bottom or when moving down inside 70px', () => {
    expect(followAfterScroll(released, 2, false).pinned).toBe(true)
    expect(
      followAfterScroll({ ...released, distance: 90 }, 70, true).pinned,
    ).toBe(true)
    // Moving up inside the band does not snap back.
    expect(
      followAfterScroll({ ...released, distance: 20 }, 50, true).pinned,
    ).toBe(false)
    // Moving down but still outside the band stays released.
    expect(
      followAfterScroll({ ...released, distance: 200 }, 71, true).pinned,
    ).toBe(false)
  })

  it('shows the jump pill past 320px and hides it at 2px', () => {
    expect(jumpVisible(false, false, 320)).toBe(false)
    expect(jumpVisible(false, false, 321)).toBe(true)
    expect(jumpVisible(true, false, 100)).toBe(true)
    expect(jumpVisible(true, false, 2)).toBe(false)
    expect(jumpVisible(true, true, 900)).toBe(false)
  })

  it('releases and restores on purpose', () => {
    expect(releaseFollow(pinned).pinned).toBe(false)
    const restored = restoreFollow({ pinned: false, jump: true, distance: 900 })
    expect(restored).toMatchObject({ pinned: true, jump: false })
  })

  it('teleports to 2.5 viewports from the end before a long glide', () => {
    expect(jumpStart(5000, 400, 6000)).toBe(5000)
    expect(jumpStart(900, 400, 6000)).toBeUndefined()
  })
})
