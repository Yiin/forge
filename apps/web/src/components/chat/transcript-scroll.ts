/**
 * Drives the transcript scroller once per animation frame, after zeron
 * (crates/ui/src/transcript.rs): the stick-to-bottom spring while pinned,
 * the own-send runway that glides a fresh prompt to the top, and the scroll
 * that keeps a folding prompt in view. The math lives in scroll-motion.ts;
 * this class only reads and writes the DOM.
 */
import {
  AT_BOTTOM_PX,
  distanceFromBottom,
  followAfterScroll,
  initialFollow,
  jumpVisible,
  releaseFollow,
  restoreFollow,
  shouldRestick,
  type FollowState,
} from './scroll-follow'
import {
  foldDuration,
  foldTargetTop,
  foldTopAt,
  framesSince,
  glideStart,
  holdDrifted,
  restingSpring,
  runwayFilled,
  runwayHold,
  runwayInset,
  runwayMinHeight,
  SETTLE_GRACE_MS,
  stepGlide,
  stepSpring,
  stepTailFloor,
  type TailFloor,
} from './scroll-motion'

/** Rows that land this soon after the transcript fills snap, not glide. */
export const ATTACH_MS = 500
/** Motion the view runs itself yields to wheel, touch and keys this long. */
export const INPUT_YIELD_MS = 120

export type ScrollHost = {
  /** The prompt's row index and offset in the content, if it is there. */
  prompt: (itemId: string) => { index: number; offset: number } | undefined
  /**
   * Height from the top of row `index` to the end of the content, without
   * the runway: the rows as laid out, plus the bottom spacer.
   */
  tailHeight: (index: number) => number
  /**
   * Height of the rows plus the bottom spacer as laid out this frame,
   * without the runway or the tail floor.
   */
  contentHeight: () => number
  /** Overlaid chrome at the bottom of the scroller, such as the composer. */
  bottomInset: () => number
  reducedMotion: () => boolean
  onFollow: (state: FollowState) => void
}

type Runway = {
  itemId: string
  /** The runway owns the viewport: glide, then hold the prompt. */
  held: boolean
  /** The glide has landed; the hold now only corrects drift. */
  positioned: boolean
  /** Once the prompt showed, its disappearance retires the runway. */
  seen: boolean
  lastTick?: number
}

type Fold = {
  row: HTMLElement
  start: number
  from: number
  to: number
  duration: number
  heightDelta: number
}

export class TranscriptScroll {
  follow: FollowState = initialFollow
  private spring = restingSpring()
  private springTick?: number
  private settledAt?: number
  /** Sub-pixel shadow of `scrollTop`; browsers round what they store. */
  private position?: number
  private runway?: Runway
  private reserved = 0
  /** The content height at the last frame, and the floor held under it. */
  private tail = 0
  private floor?: TailFloor
  private floorTick?: number
  private minHeight = 0
  private fold?: Fold
  private inputAt = -Infinity
  private attachedAt?: number
  private frame = 0

  private writing = false
  private guarded = false

  constructor(
    private scroller: HTMLElement,
    /** The content box that carries the runway's minimum height. */
    private content: HTMLElement,
    private host: ScrollHost,
  ) {
    this.guardScrollTop()
  }

  dispose() {
    cancelAnimationFrame(this.frame)
    this.frame = 0
    if (this.guarded) Reflect.deleteProperty(this.scroller, 'scrollTop')
  }

  /**
   * virtua keeps the rows in view still when a row above the viewport top
   * changes size, by moving `scrollTop`. While the view scrolls down it
   * also counts a row that straddles the top, and the streaming reply is
   * such a row while the spring follows it. virtua would then snap every new
   * line into place and the spring would never glide. So while the view
   * follows the bottom or holds a runway, only the driver writes
   * `scrollTop`; other scripts' writes are dropped. The user's own scrolling
   * does not go through this setter.
   */
  private guardScrollTop() {
    const native = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'scrollTop',
    )
    const { get, set } = native ?? {}
    if (!get || !set) return
    const owns = () =>
      !this.writing && (this.follow.pinned || this.runway?.held === true)
    Object.defineProperty(this.scroller, 'scrollTop', {
      configurable: true,
      get() {
        return get.call(this)
      },
      set(value: number) {
        if (!owns()) set.call(this, value)
      },
    })
    this.guarded = true
  }

  /** Content or layout changed: look again on the next frame. */
  kick = () => {
    if (!this.frame) this.frame = requestAnimationFrame(this.tick)
  }

  /** The transcript has rows; growth in the next moments lands at once. */
  contentArrived() {
    this.attachedAt ??= performance.now()
  }

  get holding() {
    return this.runway?.held === true
  }

  /** A scroll event. `userInput` marks wheel, touch, keys or the scrollbar. */
  scrolled(userInput: boolean) {
    const distance = distanceFromBottom(this.scroller)
    const runway = this.runway
    if (runway) {
      // Scrolling back down to the hold arms it again.
      if (
        userInput &&
        !runway.held &&
        (distance <= AT_BOTTOM_PX ||
          shouldRestick(distance, this.follow.distance))
      ) {
        runway.held = true
        runway.positioned = false
        runway.lastTick = undefined
        this.kick()
      }
      this.setFollow({
        pinned: false,
        jump: !runway.held && jumpVisible(this.follow.jump, false, distance),
        distance,
      })
      return
    }
    const next = followAfterScroll(
      this.follow,
      distance,
      userInput && !this.fold,
    )
    // A fold correction owns the view until it lands.
    if (this.fold && !this.follow.pinned) next.pinned = false
    if (next.pinned && !this.follow.pinned) this.wakeSpring()
    this.setFollow(next)
  }

  /** Wheel, touch or key input: motion the view runs itself stands down. */
  userInput() {
    this.inputAt = performance.now()
    this.position = undefined
    this.fold = undefined
    this.spring = restingSpring()
    this.springTick = undefined
    if (this.runway) {
      this.runway.held = false
      this.runway.lastTick = undefined
    }
  }

  /** Stop following on purpose: a fold, a rail jump, a selection, a link. */
  release() {
    this.fold = undefined
    this.spring = restingSpring()
    this.springTick = undefined
    if (this.runway) this.runway.held = false
    this.setFollow(releaseFollow(this.follow))
  }

  /** The jump pill: back to the bottom, or to the runway's hold. */
  toBottom() {
    this.fold = undefined
    if (this.runway) {
      this.runway.held = true
      this.runway.positioned = false
      this.runway.lastTick = undefined
      this.setFollow({ ...this.follow, pinned: false, jump: false })
    } else {
      this.setFollow(restoreFollow(this.follow))
      this.wakeSpring()
    }
    this.kick()
  }

  /**
   * The user sent a prompt: reserve the space under it and glide it to the
   * top. A later send replaces the runway with a fresh glide.
   */
  ownSend(itemId: string) {
    this.fold = undefined
    this.spring = restingSpring()
    this.springTick = undefined
    this.settledAt = undefined
    this.runway = { itemId, held: true, positioned: false, seen: false }
    this.setFollow({ ...this.follow, pinned: false, jump: false })
    this.kick()
  }

  /**
   * The bottom inset changed, such as a taller composer. A pinned view moves
   * with it at once, so the last row stays attached to the composer.
   */
  insetChanged() {
    if (!this.follow.pinned || this.runway) return
    this.snapToEnd()
    this.kick()
  }

  /**
   * A prompt folds or unfolds: its row changes height by `heightChange` px
   * while its clip eases over `heightDelta` px. Follow stops, and the row's
   * top glides into the band below the top fade on the fold's own curve.
   */
  foldStart(row: HTMLElement, heightChange: number, heightDelta: number) {
    this.release()
    const box = this.scroller.getBoundingClientRect()
    const rect = row.getBoundingClientRect()
    const from = rect.top - box.top
    const to = foldTargetTop({
      rowTop: from,
      viewportHeight: this.scroller.clientHeight,
      bottomInset: this.host.bottomInset(),
      targetHeight: rect.height + heightChange,
      scrollTop: this.read(),
      endScrollHeight: this.scroller.scrollHeight + heightChange,
    })
    if (Math.abs(to - from) <= 0.5) return
    if (this.host.reducedMotion()) {
      this.write(this.read() + from - to)
      return
    }
    this.fold = {
      row,
      start: performance.now(),
      from,
      to,
      duration: foldDuration(heightDelta),
      heightDelta,
    }
    this.kick()
  }

  private tick = (now: number) => {
    this.frame = 0
    this.reserve()
    const floored = this.holdTail(now)
    const yielding = now - this.inputAt < INPUT_YIELD_MS
    let again = false
    if (this.fold) again = this.stepFold(now)
    else if (this.runway?.held) again = yielding || this.stepRunway(now)
    // A held tail keeps the view still; the spring would only chase into
    // space that is about to go.
    else if (this.follow.pinned && !floored)
      again = yielding || this.stepFollow(now)
    if (again || floored) this.kick()
  }

  /**
   * Keep a pinned view's content from shrinking under it for a moment, so a
   * row that swaps for another does not clamp the view up and back. A tail
   * that stays short glides down instead of jumping.
   */
  private holdTail(now: number) {
    const height = this.host.contentHeight()
    const previous = this.tail
    this.tail = height
    const started = !this.floor
    this.floor =
      this.follow.pinned && !this.runway && !this.fold && !this.attaching(now)
        ? stepTailFloor({
            floor: this.floor,
            previous,
            height,
            maxDrop: this.scroller.clientHeight,
            now,
            frames: this.host.reducedMotion()
              ? Infinity
              : framesSince(this.floorTick, now),
          })
        : undefined
    this.floorTick = this.floor ? now : undefined
    this.applyMinHeight()
    // The shrink already clamped the view while it was measured; put it
    // back where it was before anything paints. A pinned view the user
    // moved last sat at the end.
    if (this.floor && started) {
      if (this.position === undefined) this.snapToEnd()
      else this.write(this.position)
    }
    return this.floor !== undefined
  }

  /**
   * Size the runway, or retire it once the reply outgrows it. The content
   * box gets a minimum height, so the reply fills the reserved space in the
   * same layout that grows it and nothing on screen moves.
   */
  private reserve() {
    const runway = this.runway
    const prompt = runway && this.host.prompt(runway.itemId)
    if (runway && !prompt) {
      // The echo can land a moment after the send; a prompt that showed and
      // then left (a refused send) ends the runway.
      if (runway.seen) this.endRunway()
      return
    }
    if (!runway || !prompt) return
    runway.seen = true
    const inset = runwayInset(prompt.index)
    const viewport = this.scroller.clientHeight
    if (runwayFilled(this.host.tailHeight(prompt.index), viewport, inset)) {
      const held = runway.held
      this.endRunway()
      if (held || distanceFromBottom(this.scroller) <= AT_BOTTOM_PX) {
        this.setFollow(restoreFollow(this.follow))
        this.wakeSpring()
      }
      return
    }
    this.setReserved(runwayMinHeight(prompt.offset, viewport, inset))
  }

  private endRunway() {
    this.runway = undefined
    this.setReserved(0)
  }

  private setReserved(height: number) {
    this.reserved = height
    this.applyMinHeight()
  }

  /** The runway's reservation or the tail floor, whichever is taller. */
  private applyMinHeight() {
    const height = Math.max(this.reserved, this.floor?.height ?? 0)
    if (Math.abs(height - this.minHeight) < 0.5) return
    this.minHeight = height
    this.content.style.minHeight = height ? `${height}px` : ''
  }

  /** Glide the prompt to its hold, then keep it there. */
  private stepRunway(now: number) {
    const runway = this.runway!
    const prompt = this.host.prompt(runway.itemId)
    if (!prompt) return false
    const hold = runwayHold(prompt.offset, runwayInset(prompt.index))
    const position = this.read()
    if (runway.positioned && !holdDrifted(position, hold)) {
      runway.lastTick = undefined
      return false
    }
    if (this.host.reducedMotion()) {
      this.write(hold)
      runway.positioned = true
      return false
    }
    const from = glideStart(position, hold, this.scroller.clientHeight)
    const next = stepGlide(from, hold, framesSince(runway.lastTick, now))
    runway.lastTick = now
    this.write(next)
    if (next !== hold) return true
    runway.positioned = true
    runway.lastTick = undefined
    return false
  }

  /** One spring frame toward the bottom. */
  private stepFollow(now: number) {
    const target = this.scroller.scrollHeight - this.scroller.clientHeight
    if (target <= 0) return false
    if (
      this.settledAt !== undefined &&
      now - this.settledAt >= SETTLE_GRACE_MS
    ) {
      this.spring = restingSpring()
      this.springTick = undefined
    }
    if (this.host.reducedMotion() || this.attaching(now)) {
      this.snapToEnd()
      this.settledAt ??= now
      return false
    }
    const position = glideStart(this.read(), target, this.scroller.clientHeight)
    const step = stepSpring(
      this.spring,
      position,
      target,
      framesSince(this.springTick, now),
    )
    this.spring = step.spring
    this.springTick = now
    this.write(step.position)
    if (target - step.position > 0.5) {
      this.settledAt = undefined
      return true
    }
    this.settledAt ??= now
    return false
  }

  private stepFold(now: number) {
    const fold = this.fold!
    if (!fold.row.isConnected) {
      this.fold = undefined
      return false
    }
    const elapsed = now - fold.start
    const desired = foldTopAt(fold, elapsed)
    const current =
      fold.row.getBoundingClientRect().top -
      this.scroller.getBoundingClientRect().top
    const correction = current - desired
    if (Math.abs(correction) > 0.1) this.write(this.read() + correction)
    if (elapsed < fold.duration) return true
    this.fold = undefined
    this.scrolled(false)
    return false
  }

  private attaching(now: number) {
    return this.attachedAt === undefined || now - this.attachedAt < ATTACH_MS
  }

  /** A spring that sat landed past the grace starts cold. */
  private wakeSpring() {
    if (
      this.settledAt !== undefined &&
      performance.now() - this.settledAt >= SETTLE_GRACE_MS
    ) {
      this.spring = restingSpring()
      this.springTick = undefined
    }
    this.settledAt = undefined
    this.kick()
  }

  /**
   * Land on the end. The rows virtua has yet to measure can overflow its
   * box and hide the spacer from `scrollHeight`, so aim past the end by the
   * whole scroll height and let the browser clamp; the next measurement
   * kicks another frame.
   */
  private snapToEnd() {
    this.writing = true
    this.scroller.scrollTop = this.scroller.scrollHeight
    this.writing = false
    this.position = this.scroller.scrollTop
  }

  private read() {
    const actual = this.scroller.scrollTop
    if (this.position !== undefined && Math.abs(actual - this.position) < 1)
      return this.position
    return actual
  }

  private write(position: number) {
    this.position = position
    if (Math.abs(this.scroller.scrollTop - position) < 0.25) return
    this.writing = true
    this.scroller.scrollTop = position
    this.writing = false
  }

  private setFollow(next: FollowState) {
    const changed =
      next.pinned !== this.follow.pinned || next.jump !== this.follow.jump
    this.follow = next
    if (changed) this.host.onFollow(next)
  }
}
