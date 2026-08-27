import { useCallback, useEffect, useState } from 'react'
import { ArrowUp, Folder } from 'lucide-react'
import { Button } from './ui/button'
import { ScrollArea } from './ui/scroll-area'
import { api } from '../lib/api'
import { folderName } from '../lib/folder-name'

type Listing = {
  path: string
  parent: string | null
  entries: Array<{ name: string; path: string }>
}

export function FolderPicker({
  initialPath,
  onSelect,
  onCancel,
}: {
  initialPath?: string
  onSelect: (path: string) => void
  onCancel?: () => void
}) {
  const [listing, setListing] = useState<Listing | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (path?: string, fallback = true) => {
    setLoading(true)
    setError(null)
    try {
      setListing((await api.listDirectories(path)) as Listing)
    } catch (cause) {
      if (path && fallback) return load(undefined, false)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(initialPath)
  }, [load, initialPath])

  return (
    <div className="flex flex-col gap-2 rounded-md border p-2">
      <p
        className="truncate text-xs text-muted-foreground"
        title={listing?.path}
      >
        {listing?.path ?? '…'}
      </p>
      <ScrollArea className="h-48 rounded-md border">
        <div className="flex flex-col p-1">
          {listing?.parent && (
            <button
              type="button"
              className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
              aria-label="Parent folder"
              onClick={() => void load(listing.parent ?? undefined)}
            >
              <ArrowUp className="size-4 text-muted-foreground" />
              <span>..</span>
            </button>
          )}
          {loading && (
            <div
              className="px-2 py-1.5 text-sm text-muted-foreground"
              role="status"
            >
              Loading…
            </div>
          )}
          {error && (
            <div className="px-2 py-1.5 text-sm text-destructive" role="alert">
              {error}
            </div>
          )}
          {!loading &&
            !error &&
            listing?.entries.map((entry) => (
              <button
                type="button"
                key={entry.path}
                className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                onClick={() => void load(entry.path)}
              >
                <Folder className="size-4 text-muted-foreground" />
                <span className="truncate">{entry.name}</span>
              </button>
            ))}
          {!loading && !error && listing?.entries.length === 0 && (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">
              No subfolders
            </div>
          )}
        </div>
      </ScrollArea>
      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!listing}
          onClick={() => listing && onSelect(listing.path)}
        >
          Select “{folderName(listing?.path ?? '')}”
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  )
}
