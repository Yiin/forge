import type {
  TerminalErrorBody,
  TerminalErrorCode,
} from '@forge/protocol/terminal'

export class TerminalError extends Error {
  constructor(
    readonly code: TerminalErrorCode,
    readonly status: 400 | 403 | 404 | 409 | 410 | 415 | 429 | 503,
    message: string,
    readonly details?: TerminalErrorBody['error']['details'],
  ) {
    super(message)
  }
  body(): TerminalErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    }
  }
}
