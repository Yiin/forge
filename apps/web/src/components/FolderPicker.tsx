import { useCallback, useEffect, useState } from 'react'
import { ArrowUp, Folder } from 'lucide-react'
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
    <div className="folder-picker">
      <div className="folder-picker-path" title={listing?.path}>
        {listing?.path ?? '…'}
      </div>
      <div className="folder-picker-list">
        {listing?.parent && (
          <button
            type="button"
            className="folder-picker-row"
            aria-label="Parent folder"
            onClick={() => void load(listing.parent ?? undefined)}
          >
            <ArrowUp size={15} />
            <span>..</span>
          </button>
        )}
        {loading && (
          <div className="folder-picker-status" role="status">
            Loading…
          </div>
        )}
        {error && (
          <div className="folder-picker-status" role="alert">
            {error}
          </div>
        )}
        {!loading &&
          !error &&
          listing?.entries.map((entry) => (
            <button
              type="button"
              key={entry.path}
              className="folder-picker-row"
              onClick={() => void load(entry.path)}
            >
              <Folder size={15} />
              <span>{entry.name}</span>
            </button>
          ))}
        {!loading && !error && listing?.entries.length === 0 && (
          <div className="folder-picker-status">No subfolders</div>
        )}
      </div>
      <div className="folder-picker-footer">
        <button
          type="button"
          className="folder-picker-select"
          disabled={!listing}
          onClick={() => listing && onSelect(listing.path)}
        >
          Select “{folderName(listing?.path ?? '')}”
        </button>
        {onCancel && (
          <button
            type="button"
            className="folder-picker-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  )
}
