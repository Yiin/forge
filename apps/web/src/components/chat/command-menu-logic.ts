import type { ComposerTriggerKind } from './composer-triggers'
import type { ComposerCommand } from './CommandMenu'

export function groupComposerCommands(
  commands: ComposerCommand[],
  kind: ComposerTriggerKind | null,
) {
  const groups =
    kind === 'slash-command'
      ? ['Built-in', 'Harness']
      : kind === 'skill'
        ? ['Skills']
        : kind === 'path'
          ? ['Files']
          : ['Built-in', 'Harness', 'Skills', 'Files']
  return groups
    .map((group) => ({
      group,
      commands: commands.filter((command) => command.group === group),
    }))
    .filter((entry) => entry.commands.length)
}

/**
 * The menu rows for a trigger, filtered the zeron way: labels that start with
 * the query first, then labels that contain it. Order is stable in each rank.
 * The leading sigil (`/`, `$`, `@`) is not part of the match.
 */
export function filterComposerCommands(
  commands: ComposerCommand[],
  kind: ComposerTriggerKind | null,
  query: string,
) {
  const all = groupComposerCommands(commands, kind).flatMap(
    (entry) => entry.commands,
  )
  const needle = query.trim().toLowerCase()
  if (!needle) return all
  const bare = (command: ComposerCommand) =>
    command.label.replace(/^[/$@]/, '').toLowerCase()
  return [
    ...all.filter((command) => bare(command).startsWith(needle)),
    ...all.filter(
      (command) =>
        !bare(command).startsWith(needle) && bare(command).includes(needle),
    ),
  ]
}

/** The empty-state line for a trigger, in zeron's wording. */
export function emptyCommandText(
  commands: ComposerCommand[],
  kind: ComposerTriggerKind | null,
) {
  const available = groupComposerCommands(commands, kind).length > 0
  if (kind === 'skill')
    return available
      ? 'No matching skills'
      : 'No skills available for this project'
  if (kind === 'path')
    return available ? 'No matching files' : 'No files available'
  return available ? 'No matching commands' : 'No commands available'
}
