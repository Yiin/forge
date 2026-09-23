import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import { ChevronDown, Folder, FolderOpen, Plus, X } from 'lucide-react'
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { FolderPicker } from '../FolderPicker'
import { folderName } from '../../lib/folder-name'
import {
  CARD_CLASS,
  CARD_SEPARATOR_CLASS,
  CARD_VIEWPORT_CLASS,
  FOOTER_CHIP_CLASS,
  MENU_EMPTY_CLASS,
  MENU_ROW_CLASS,
  SEARCH_FIELD_CLASS,
} from './zeron-styles'
import { EDGE_FADE_CLASS, useEdgeFade } from './useEdgeFade'

type Project = { id: string; name: string }

const ICON_CLASS = 'size-3 shrink-0 text-muted-foreground/70'

/** Prefix matches first, then substring matches, stable in each rank. */
function rankProjects(projects: Project[], query: string) {
  const needle = query.trim().toLowerCase()
  if (!needle) return projects
  const name = (project: Project) => project.name.toLowerCase()
  return [
    ...projects.filter((project) => name(project).startsWith(needle)),
    ...projects.filter(
      (project) =>
        !name(project).startsWith(needle) && name(project).includes(needle),
    ),
  ]
}

/**
 * The new-thread destination row above the pill: the project chip, and for
 * a projectless draft the folder it will run in.
 */
export function DestinationChips({
  projects,
  projectId,
  targetPath,
  disabled,
  onProject,
  onNewProject,
  onNoProject,
  onFolder,
}: {
  projects: Project[]
  projectId?: string
  targetPath?: string
  disabled?: boolean
  onProject: (id: string) => void
  onNewProject: () => void
  onNoProject: () => void
  onFolder: (path: string) => void
}) {
  const [folderOpen, setFolderOpen] = useState(false)
  return (
    <>
      {!projectId && (
        <Popover open={folderOpen} onOpenChange={setFolderOpen}>
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label="Folder"
                disabled={disabled}
                className={FOOTER_CHIP_CLASS}
              />
            }
          >
            <FolderOpen aria-hidden className={ICON_CLASS} />
            <span className="truncate">
              {targetPath ? folderName(targetPath) : 'Choose folder'}
            </span>
            <ChevronDown
              aria-hidden
              className="size-3 shrink-0 text-muted-foreground/50"
            />
          </PopoverTrigger>
          <PopoverPopup
            side="bottom"
            align="end"
            sideOffset={6}
            className={cn(CARD_CLASS, 'w-[320px] max-w-[calc(100vw-16px)]')}
            viewportClassName={CARD_VIEWPORT_CLASS}
          >
            <FolderPicker
              initialPath={targetPath}
              onSelect={(path) => {
                onFolder(path)
                setFolderOpen(false)
              }}
              onCancel={() => setFolderOpen(false)}
            />
          </PopoverPopup>
        </Popover>
      )}
      <ProjectChip
        projects={projects}
        projectId={projectId}
        disabled={disabled}
        onProject={onProject}
        onNewProject={onNewProject}
        onNoProject={onNoProject}
      />
    </>
  )
}

function ProjectChip({
  projects,
  projectId,
  disabled,
  onProject,
  onNewProject,
  onNoProject,
}: {
  projects: Project[]
  projectId?: string
  disabled?: boolean
  onProject: (id: string) => void
  onNewProject: () => void
  onNoProject: () => void
}) {
  const [open, setOpen] = useState(false)
  const search = useRef<HTMLInputElement>(null)
  const current = projects.find((project) => project.id === projectId)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Project"
            disabled={disabled}
            className={FOOTER_CHIP_CLASS}
          />
        }
      >
        <Folder aria-hidden className={ICON_CLASS} />
        <span className="truncate">{current?.name ?? 'No project'}</span>
        <ChevronDown
          aria-hidden
          className="size-3 shrink-0 text-muted-foreground/50"
        />
      </PopoverTrigger>
      <PopoverPopup
        side="bottom"
        align="end"
        sideOffset={6}
        initialFocus={search}
        className={cn(CARD_CLASS, 'w-[280px] max-w-[calc(100vw-16px)]')}
        viewportClassName={CARD_VIEWPORT_CLASS}
      >
        <ProjectList
          search={search}
          projects={projects}
          projectId={projectId}
          onPick={(id) => {
            setOpen(false)
            if (id !== projectId) onProject(id)
          }}
          onNewProject={() => {
            setOpen(false)
            onNewProject()
          }}
          onNoProject={() => {
            setOpen(false)
            onNoProject()
          }}
        />
      </PopoverPopup>
    </Popover>
  )
}

function ProjectList({
  search,
  projects,
  projectId,
  onPick,
  onNewProject,
  onNoProject,
}: {
  search: RefObject<HTMLInputElement | null>
  projects: Project[]
  projectId?: string
  onPick: (id: string) => void
  onNewProject: () => void
  onNoProject: () => void
}) {
  const [query, setQuery] = useState('')
  const list = useEdgeFade<HTMLDivElement>()
  const rows = rankProjects(projects, query)
  const [cursor, setCursor] = useState(() =>
    rows.findIndex((project) => project.id === projectId),
  )
  useEffect(() => {
    list.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [cursor, list])
  const onKeyDown = (event: KeyboardEvent) => {
    const down =
      event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'n')
    const up = event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'p')
    if ((down || up) && rows.length > 0) {
      event.preventDefault()
      setCursor((current) =>
        current < 0
          ? down
            ? 0
            : rows.length - 1
          : (current + (down ? 1 : -1) + rows.length) % rows.length,
      )
    } else if (event.key === 'Enter' && rows[cursor]) {
      event.preventDefault()
      onPick(rows[cursor]!.id)
    }
  }
  return (
    <div className="flex flex-col" onKeyDown={onKeyDown}>
      <input
        ref={search}
        aria-label="Search projects"
        placeholder="Search projects…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setCursor(0)
        }}
        className={SEARCH_FIELD_CLASS}
      />
      <div
        ref={list}
        role="listbox"
        aria-label="Projects"
        className={cn(
          'flex max-h-[280px] flex-col gap-0.5 overflow-y-auto',
          EDGE_FADE_CLASS,
        )}
      >
        {rows.length === 0 ? (
          <p className={MENU_EMPTY_CLASS}>
            {projects.length === 0
              ? 'No projects on this device.'
              : 'No projects match.'}
          </p>
        ) : (
          rows.map((project, index) => (
            <button
              key={project.id}
              type="button"
              role="option"
              aria-selected={project.id === projectId}
              data-active={index === cursor}
              onMouseEnter={() => setCursor(index)}
              onClick={() => onPick(project.id)}
              className={MENU_ROW_CLASS}
            >
              <span className="truncate">{project.name}</span>
            </button>
          ))
        )}
      </div>
      <div className={cn(CARD_SEPARATOR_CLASS, 'my-1 bg-border/60')} />
      <button type="button" onClick={onNewProject} className={MENU_ROW_CLASS}>
        <Plus aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        New project…
      </button>
      <button type="button" onClick={onNoProject} className={MENU_ROW_CLASS}>
        <X aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        Don't work in a project
      </button>
    </div>
  )
}
