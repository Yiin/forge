import { describe, expect, it } from 'vitest'
import {
  branchTriggerLabel,
  currentWorkspaceLabel,
  defaultBaseRef,
  effectiveWorkspaceMode,
  isModeLocked,
  workspaceModeLabel,
} from './workspace-picker-logic'

const ref = (name: string, patch: Partial<{ isDefault: boolean }> = {}) => ({
  name,
  current: false,
  isDefault: patch.isDefault ?? false,
  isRemote: false,
  remoteName: null,
  worktreePath: null,
})

describe('workspace picker logic', () => {
  it('labels workspace modes and active workspaces', () => {
    expect(workspaceModeLabel('local')).toBe('Current checkout')
    expect(workspaceModeLabel('worktree')).toBe('New worktree')
    expect(currentWorkspaceLabel(null)).toBe('Current checkout')
    expect(currentWorkspaceLabel('/tmp/worktree')).toBe('Current worktree')
  })

  it('uses the session worktree as the effective mode and lock', () => {
    expect(
      effectiveWorkspaceMode({
        worktreePath: '/tmp/w',
        hasSession: true,
        draftMode: 'local',
      }),
    ).toBe('worktree')
    expect(isModeLocked({ worktreePath: '/tmp/w', hasSession: true })).toBe(
      true,
    )
    expect(isModeLocked({ worktreePath: null, hasSession: true })).toBe(false)
  })

  it('uses a stored draft mode when no session exists', () => {
    expect(
      effectiveWorkspaceMode({
        worktreePath: null,
        hasSession: false,
        draftMode: 'worktree',
      }),
    ).toBe('worktree')
    expect(
      effectiveWorkspaceMode({
        worktreePath: null,
        hasSession: false,
        draftMode: undefined,
      }),
    ).toBe('local')
  })

  it('labels a base ref as From branch before worktree creation', () => {
    expect(
      branchTriggerLabel({
        mode: 'worktree',
        worktreePath: null,
        branch: 'main',
      }),
    ).toBe('From main')
    expect(
      branchTriggerLabel({ mode: 'local', worktreePath: null, branch: 'main' }),
    ).toBe('main')
    expect(
      branchTriggerLabel({ mode: 'local', worktreePath: null, branch: null }),
    ).toBe('Select branch')
  })

  it('prefers the default ref over the current branch', () => {
    expect(
      defaultBaseRef(
        [ref('feature'), ref('main', { isDefault: true })],
        'feature',
      ),
    ).toBe('main')
    expect(defaultBaseRef([ref('feature')], 'feature')).toBe('feature')
    expect(defaultBaseRef([], null)).toBeNull()
  })
})
