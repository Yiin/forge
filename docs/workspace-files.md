# Workspace files

`/api/workspace` reads the selected session's persisted cwd or an explicit project folder.
It does not start a provider or create a session.
The `none` target returns `no_workspace`.
Projects without Git support ordinary file operations.

Use `kind=session&sessionId=...` or `kind=project&projectId=...` on GET requests.
The routes are `target`, `files`, `search`, `file`, `media`, and `changes`.
`files` takes a directory `path`, visibility flags, and an optional cursor.
`search` matches filenames and relative paths, with at most 200 results.
Hidden entries appear by default. Ignored entries do not.
Git supplies ignore rules, including rules matching tracked paths.
Both controls always exclude `.git` and `.forge-save-` filenames.

JSON successes include `workspace`.
Media responses carry `X-Workspace-Id` and `X-Workspace-Revision`.
Reads accept `expectedWorkspaceId` and `expectedWorkspaceRevision` to reject stale requests.
Protocol schemas live in `@forge/protocol/workspace`.

## Conditional saves

`PUT /api/workspace/file` accepts session targets and replaces existing editable files.
Send the target, relative path, LF text, workspace identity/revision, content hash, and file revision from the loaded snapshot.
The service preserves UTF-8 BOM, newline form, and permission mode.
The content hash covers exact stored bytes, including BOM and CRLF.
The file revision also covers inode, size, mode, and high-resolution timestamps.
Equal-content replacements and competing no-op saves can therefore conflict.

A conflict returns HTTP 409 with its reason and available current metadata.
Clients keep dirty text and decide whether to reload or reconcile it.
Binary files, invalid UTF-8, mixed/lone-CR newlines, and files without write mode bits remain read-only.
Editable text is limited to 1 MiB. Text preview is limited to 8 MiB.
Media streams through validated descriptors with backpressure.
Active documents, including HTML and SVG, use inert downloads.

Linux access traverses each directory from the previous open descriptor with no-follow flags.
Reads, scans, media, watches, and save staging use this traversal.
Publication and cleanup use the validated parent descriptor through `/proc/self/fd`.
Unsupported platforms return an explicit unavailable error.
Directory symlinks are never traversed. Tree entries expose no symlink destination metadata.

Saves queue by canonical file path. Publication takes the repository mutation gate.
Workspace PATCH takes the same gate and invalidates persisted revisions before changing a checkout or target.
PATCH's dirty check compares Git-root-relative paths with each staged file's identity and revision.
Publication and cleanup recheck that ownership. Observed temporary changes block both operations.
Tracked edits, unrelated untracked files, and temporary-name lookalikes still reject PATCH.
Save cleanup releases each ownership record.
Explicit workspace selection can recover a missing worktree or invalid old workspace metadata.
It resolves the project repository, takes its mutation gate, and invalidates affected persisted revisions.
File reads and saves still reject unavailable or invalid targets.
Native lifecycle work must preserve this gate, revision invalidation, and effective cwd behavior.

Atomic rename prevents partially written replacements.
It does not provide compare-and-swap against external programs.
An external writer can change the file between final comparison and rename.
An external process can also move a directory between validation and publication.
Descriptor paths limit symlink retargeting; they do not make external directory moves atomic with validation.
A failure after rename reports `publication_uncertain` and `publicationMayHaveHappened: true`.
The service does not roll back over a later external edit.

## Revisions and invalidations

Workspace identity describes the physical root and its per-worktree Git directory.
Provider, account, session, branch, and runtime generation do not enter that identity.
Persisted target revisions detect observed target, root, and checkout changes across server restarts.
Checkout invalidation groups nested project aliases by their shared per-worktree Git directory.
The mutation gate separately groups worktrees by their repository common directory.

`changes` sends SSE invalidations, with a new watch ID and resync baseline on every connection.
Events contain a sequence, resolved workspace, paths, resync flag, and watch mode.
Paths are invalidations, not a rename or edit history.
There is no durable replay cursor.
Target replacement sends a final resync event when possible and closes the subscription.

Nonrecursive native watches share each workspace root.
A one-second poll shares each checkout observation across subscribers and project aliases.
It reads symbolic HEAD, the resolved object ID or unborn state, and HEAD metadata.
This covers packed refs and linked-worktree metadata outside the visible root.
Unobserved external A-to-B-to-A changes are not an audit-log guarantee.
Watch failures report `repair_only` or `unavailable`.
A 120-second full invalidation also retries directory registration.
This repair does not claim continuous native watching.
Structural events coalesce into bounded parent refreshes. Content edits do not scan the directory tree.
Events received during a refresh remain pending until another bounded pass handles them.
Watch registration closes its traversal descriptors after validation. The kernel watch keeps the inode association.
An idle poll reuses validated physical observations while checking each target row. Unchanged revisions cause no row update.

Native watches have an 8,000-directory ceiling across the service.
The service permits 32 shared roots, 64 subscribers, and eight active filesystem operations.
PATCH, reads, saves, and watch work share this admission limit before filesystem resolution or queue insertion.
Cancellation releases queued callers without letting later callers pass the active predecessor.
It coalesces events for 100 ms and flushes each burst within one second.
Raw events stop at 256. Each subscriber queue stops at 64 batches or 1 MiB.
Overflow discards path detail and requires resync.
A blocked SSE write closes after six seconds.
Disconnect and service shutdown close owned streams, watches, descriptors, timers, and pending file work.

Directory pages contain at most 500 entries and scan at most 50,000 entries.
Cursors bind the workspace, directory, visibility flags, and listing fingerprint.
A changed listing returns `listing_changed` instead of combining different pages.
Scan limits, timeouts, unreadable children, and races carry explicit partial-result reasons.
Ordinary operations have a six-second deadline.
JSON requests stop at 8 MiB; accumulated listing metadata stops at 16 MiB.
These transport bounds supplement the source-derived Comet limits.

On Linux, each Git command owns a process group. Timeout, abort, and output overflow kill that group.
Leader exit also ends surviving helpers. Cleanup has a one-second bound and does not wait indefinitely for held pipes.
Git and worktree provisioning receive the PATCH request signal. Interrupted Git mutations may already have changed checkout state.
Persisted revisions remain invalidated; the service does not attempt an unsafe rollback.
A descendant that creates a separate process group escapes this ownership boundary.

This backend does not complete editor UI, projectless draft promotion, native runtime invalidation, or separate-origin previews.
Those remain separate epic children.
