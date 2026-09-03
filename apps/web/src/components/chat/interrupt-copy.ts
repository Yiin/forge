const INTERRUPT_REASON_COPY: Record<string, string> = {
  cancelled: 'You stopped this turn.',
  server_restart: 'Forge restarted. This turn stopped.',
  server_crashed: 'Forge crashed and restarted. This turn stopped.',
  agent_process_died: 'The agent process stopped.',
  pty_process_died: 'The terminal process stopped.',
  max_turn_time: 'The turn hit its time limit.',
  error: 'The turn failed.',
}

export function interruptReasonText(
  reason?: string,
  version?: string,
): string {
  if (reason === 'server_updated') {
    return version
      ? `Forge updated to v${version} and restarted. This turn stopped.`
      : 'Forge updated and restarted. This turn stopped.'
  }

  if (reason === undefined) return 'Turn stopped.'
  return INTERRUPT_REASON_COPY[reason] ?? `Turn stopped (${reason}).`
}
