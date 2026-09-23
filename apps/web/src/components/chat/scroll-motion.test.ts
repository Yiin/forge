import { describe, expect, it } from 'vitest'
import {
  CHASE_MAX_LEAD,
  foldCurve,
  foldDuration,
  foldTargetTop,
  foldTopAt,
  framesSince,
  glideStart,
  holdDrifted,
  MAX_CATCHUP_FRAMES,
  OWN_SEND_INSET,
  restingSpring,
  runwayFilled,
  runwayHold,
  runwayInset,
  runwayMinHeight,
  RUNWAY_SLACK,
  springIdle,
  stepGlide,
  stepSpring,
  type Spring,
} from './scroll-motion'
import { easeInOut, easeOut } from './motion'

/** Runs the spring to rest against a fixed target; returns every position. */
function glide(from: number, target: number, frames = 200) {
  let spring: Spring = restingSpring()
  let position = from
  const trace = [position]
  for (let frame = 0; frame < frames && position !== target; frame += 1) {
    const step = stepSpring(spring, position, target, 1)
    spring = step.spring
    position = step.position
    trace.push(position)
  }
  return trace
}

describe('stick-to-bottom spring', () => {
  it('glides to a fixed target without overshoot and lands exactly', () => {
    const trace = glide(0, 600)
    expect(trace.at(-1)).toBe(600)
    for (let index = 1; index < trace.length; index += 1) {
      expect(trace[index]).toBeGreaterThanOrEqual(trace[index - 1])
      expect(trace[index]).toBeLessThanOrEqual(600)
    }
    // It starts gently: the first frame covers under a tenth of the way.
    expect(trace[1]).toBeLessThan(60)
    // Damping 0.7, stiffness 0.05, mass 1.25 covers 90% of 600px in about
    // half a second, then eases into the end.
    expect(trace[30]).toBeGreaterThan(540)
    expect(trace.length).toBeGreaterThan(40)
    expect(trace.length).toBeLessThan(80)
  })

  it('matches the use-stick-to-bottom step', () => {
    // v = (0.7 * 0 + 0.05 * 100) / 1.25 = 4 on a cold first frame.
    const step = stepSpring(restingSpring(), 0, 100, 1)
    expect(step.position).toBeCloseTo(4, 6)
    expect(step.spring.velocity).toBeCloseTo(4, 6)
  })

  it('leads the growing edge by at most 32px while content streams', () => {
    let spring = restingSpring()
    let position = 0
    let target = 0
    for (let frame = 0; frame < 600; frame += 1) {
      target += 6
      const step = stepSpring(spring, position, target, 1)
      spring = step.spring
      position = step.position
    }
    // At cruise it trails the bottom by the chase lead and never passes it.
    expect(target - position).toBeGreaterThan(0)
    expect(target - position).toBeLessThanOrEqual(CHASE_MAX_LEAD + 1)
    expect(spring.targetVelocity).toBeCloseTo(6, 1)
  })

  it('drops the growth estimate when the target shrinks', () => {
    let spring = restingSpring()
    let position = 0
    for (let target = 10; target < 400; target += 10) {
      const step = stepSpring(spring, position, target, 1)
      spring = step.spring
      position = step.position
    }
    expect(spring.targetVelocity).toBeGreaterThan(1)
    const shrunk = stepSpring(spring, position, 200, 1)
    expect(shrunk.spring.targetVelocity).toBe(0)
  })

  it('integrates a hitch as several frames', () => {
    const one = glide(0, 600, 4).at(-1)!
    const hitch = stepSpring(restingSpring(), 0, 600, 4).position
    expect(hitch).toBeCloseTo(one, 6)
  })

  it('caps catch-up frames and settles', () => {
    expect(framesSince(undefined, 100)).toBe(1)
    expect(framesSince(0, 1000 / 60)).toBeCloseTo(1, 6)
    expect(framesSince(0, 10_000)).toBe(MAX_CATCHUP_FRAMES)
    expect(springIdle(restingSpring())).toBe(true)
    expect(springIdle({ velocity: 3, targetVelocity: 0 })).toBe(false)
  })

  it('teleports to 2.5 viewports before a long glide', () => {
    expect(glideStart(0, 5000, 400)).toBe(4000)
    expect(glideStart(4500, 5000, 400)).toBe(4500)
    expect(glideStart(5000, 0, 400)).toBe(1000)
  })
})

describe('own-send runway', () => {
  it('rests a prompt where the first row of a chat rests', () => {
    // forge's first row sits 26px down; a prompt row carries 16px itself.
    expect(OWN_SEND_INSET).toBe(10)
    expect(runwayInset(0)).toBe(0)
    expect(runwayInset(4)).toBe(10)
    expect(runwayHold(1200, 10)).toBe(1190)
  })

  it('reserves space down to the viewport bottom plus the slack', () => {
    // A prompt at 1200px in a 600px view needs content to 1792px.
    expect(runwayMinHeight(1200, 600, 10)).toBe(1190 + 600 + RUNWAY_SLACK)
    // Filled once the rows from the prompt down pass that same line.
    expect(runwayFilled(592, 600, 10)).toBe(false)
    expect(runwayFilled(593, 600, 10)).toBe(true)
  })

  it('glides 85% per frame, about 90% in 230ms, then snaps', () => {
    let position = 0
    for (let frame = 0; frame < 14; frame += 1)
      position = stepGlide(position, 1000, 1)
    expect(position).toBeGreaterThan(890)
    expect(position).toBeLessThan(1000)
    expect(stepGlide(999.5, 1000, 1)).toBe(1000)
    // A hitch covers the same ground in one step.
    expect(stepGlide(0, 1000, 2)).toBeCloseTo(1000 * (1 - 0.85 ** 2), 6)
  })

  it('corrects a view above the hold but rests inside the slack', () => {
    expect(holdDrifted(1000, 1000)).toBe(false)
    expect(holdDrifted(1003, 1000)).toBe(false)
    expect(holdDrifted(998, 1000)).toBe(true)
    expect(holdDrifted(1010, 1000)).toBe(true)
  })
})

describe('fold correction', () => {
  it('times and curves the fold like zeron', () => {
    expect(foldDuration(0)).toBe(220)
    expect(foldDuration(100)).toBe(252)
    expect(foldDuration(5000)).toBe(850)
    expect(foldCurve(200)).toBe(easeOut)
    expect(foldCurve(800)).toBe(easeInOut)
  })

  it('keeps the row top inside the band under the top fade', () => {
    const view = { viewportHeight: 800, bottomInset: 100, targetHeight: 200 }
    // Above the band: brought down to 52px.
    expect(foldTargetTop({ ...view, rowTop: -300 })).toBe(52)
    // Inside the band: left alone.
    expect(foldTargetTop({ ...view, rowTop: 300 })).toBe(300)
    // Too low for its new height: lifted clear of the composer.
    expect(foldTargetTop({ ...view, rowTop: 600 })).toBe(800 - 100 - 200 - 12)
    // Taller than the band: its top wins.
    expect(foldTargetTop({ ...view, targetHeight: 2000, rowTop: 400 })).toBe(52)
  })

  it('moves the row top on the fold curve', () => {
    const fold = { from: -300, to: 52, duration: 300, heightDelta: 200 }
    expect(foldTopAt(fold, 0)).toBe(-300)
    expect(foldTopAt(fold, 300)).toBe(52)
    expect(foldTopAt(fold, 150)).toBeCloseTo(-300 + 352 * easeOut(0.5), 6)
    expect(foldTopAt(fold, 900)).toBe(52)
  })
})
