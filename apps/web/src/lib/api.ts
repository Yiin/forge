import {
  answerQuestion,
  btw,
  createProject,
  createSession,
  fork,
  interrupt,
  prompt,
  type AnswerQuestion,
  type Btw,
  type CreateProject,
  type CreateSession,
  type Fork,
  type Interrupt,
  type Prompt,
} from '@forge/protocol/commands'
export type ApiOptions = { baseUrl?: string; fetch?: typeof globalThis.fetch }
type BodySchema = { parse: (value: unknown) => unknown }
const base = () =>
  typeof window === 'undefined' ? 'http://localhost:3000' : ''

export class ForgeApi {
  private readonly baseUrl: string
  private readonly fetcher: typeof globalThis.fetch
  constructor(options: ApiOptions = {}) {
    this.baseUrl = options.baseUrl ?? base()
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
  }
  createProject(input: CreateProject) {
    return this.post('/api/projects', createProject, input)
  }
  archiveProject(projectId: string) {
    return this.post('/api/projects/archive', null, { projectId })
  }
  createSession(input: CreateSession) {
    return this.post('/api/sessions', createSession, input)
  }
  prompt(input: Prompt) {
    return this.post(`/api/sessions/${input.sessionId}/prompt`, prompt, input)
  }
  interrupt(input: Interrupt) {
    return this.post(
      `/api/sessions/${input.sessionId}/interrupt`,
      interrupt,
      input,
    )
  }
  answerQuestion(input: AnswerQuestion) {
    return this.post(
      `/api/sessions/${input.sessionId}/answer`,
      answerQuestion,
      input,
    )
  }
  fork(input: Fork) {
    return this.post(`/api/sessions/${input.sessionId}/fork`, fork, input)
  }
  btw(input: Btw) {
    return this.post(`/api/sessions/${input.sessionId}/btw`, btw, input)
  }
  private async post(path: string, schema: BodySchema | null, body: unknown) {
    const data = schema ? schema.parse(body) : body
    const requestId = makeRequestId()
    for (let attempt = 0; ; attempt++) {
      let response: Response
      try {
        response = await this.fetcher(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-request-id': requestId,
          },
          body: JSON.stringify(data),
        })
      } catch (error) {
        if (attempt >= 1) throw error
        continue
      }
      if (!response.ok)
        throw new Error(`Forge API request failed (${response.status})`)
      return await response.json()
    }
  }
}
export const api = new ForgeApi()

function makeRequestId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
}
