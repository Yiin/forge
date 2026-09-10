// Comet limits, text rules, and search ranking: workspace_files.rs.
// Copyright (c) 2026 Wing. MIT license: THIRD_PARTY_NOTICES.md.
export const WORKSPACE_LIMITS = {
  page: 500,
  scan: 50_000,
  search: 200,
  query: 256,
  timeoutMs: 6000,
  editBytes: 1_048_576,
  previewBytes: 8_388_608,
  metadataBytes: 16 * 1024 * 1024,
  requestBytes: 8 * 1024 * 1024,
  operations: 8,
  watchDirectories: 8000,
  watchRoots: 32,
  subscribers: 64,
  watchEvents: 256,
  subscriberBatches: 64,
  subscriberBytes: 1024 * 1024,
  debounceMs: 100,
  burstMs: 1000,
  repairMs: 120_000,
  checkoutPollMs: 1000,
} as const
