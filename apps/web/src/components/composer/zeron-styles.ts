/**
 * Class recipes for zeron's composer chrome (see the zeron composer spec,
 * sections 3 and 4). They live in one place so the model chip, footer chips,
 * slash menu and pickers share one look.
 */

/** Popover card: radius 12, 1px border, 4px inset, 2px gap between rows. */
export const CARD_CLASS =
  'rounded-[12px] border border-border bg-popover p-1 text-[13px] text-foreground shadow-lg backdrop-blur-[16px]'

/** Viewport override for PopoverPopup so the card controls its own padding. */
export const CARD_VIEWPORT_CLASS = 'p-0 [--viewport-inline-padding:0px]'

/** menu_row: 6px 8px padding, radius 7, washed on hover and on the cursor. */
export const MENU_ROW_CLASS =
  'flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-[7px] px-2 py-1.5 text-left text-[13px] text-foreground/90 outline-none transition-colors duration-150 hover:bg-wash/11 hover:text-foreground data-[active=true]:bg-wash/11 data-[active=true]:text-foreground not-dark:hover:bg-wash/6 not-dark:data-[active=true]:bg-wash/6 disabled:cursor-default disabled:opacity-55'

/** Standard picker search field: borderless, iconless, ink(.04) fill. */
export const SEARCH_FIELD_CLASS =
  'mb-1 w-full rounded-[7px] border-0 bg-ink/4 px-2.5 py-1.5 text-[13px] text-foreground outline-none placeholder:text-faint-foreground'

/** Empty or loading line inside a picker. */
export const MENU_EMPTY_CLASS = 'p-2 text-[12px] text-faint-foreground'

/** Full-bleed separator inside a card. */
export const CARD_SEPARATOR_CLASS = '-mx-1 my-0.5 h-px bg-ink/7'

/** footer_chip: 20px tall interactive chip under or above the pill. */
export const FOOTER_CHIP_CLASS =
  'inline-flex h-5 max-w-[280px] min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-[6px] px-2 text-[12px] font-medium text-muted-foreground/70 outline-none transition-colors duration-150 hover:bg-accent hover:text-foreground/80 focus-visible:bg-accent focus-visible:text-foreground/80 data-popup-open:bg-accent disabled:cursor-default disabled:opacity-55 pointer-coarse:h-8'

/** footer_label: the read-only twin of FOOTER_CHIP_CLASS. */
export const FOOTER_LABEL_CLASS =
  'inline-flex h-5 max-w-40 min-w-0 shrink-0 items-center gap-1.5 px-2 text-[12px] font-medium text-muted-foreground/60'

/** Round 28px icon control inside the pill (attach button). */
export const PILL_ICON_BUTTON_CLASS =
  'relative inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-ink/10 focus-visible:bg-ink/10 focus-visible:outline-none pointer-coarse:after:absolute pointer-coarse:after:-inset-2 pointer-coarse:after:content-[""]'
