import {
  answerQuestion,
  cancelQuestion,
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
  type PromoteDraft,
  type EpicStart,
} from '@forge/protocol/commands'
import { putUpload } from './upload'
export type ApiOptions = { baseUrl?: string; fetch?: typeof globalThis.fetch }
export type UploadProgress = (fraction: number) => void
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
  listSessions(projectId?: string) {
    return this.get(
      `/api/sessions${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    )
  }
  listChildSessions(parentSessionId: string) {
    return this.get(
      `/api/sessions?parentSessionId=${encodeURIComponent(parentSessionId)}`,
    )
  }
  getSession(sessionId: string) {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}`)
  }
  listProjects() {
    return this.get('/api/projects')
  }
  listSettingsProjects() {
    return this.get('/api/projects?includeArchived=1')
  }
  renameProject(projectId: string, name: string) {
    return this.post(
      `/api/projects/${encodeURIComponent(projectId)}/rename`,
      null,
      { name },
    )
  }
  archiveProjectById(projectId: string) {
    return this.post(
      `/api/projects/${encodeURIComponent(projectId)}/archive`,
      null,
      {},
    )
  }
  getSettings() {
    return this.get('/api/settings')
  }
  saveSettings(input: Record<string, unknown>) {
    return this.put('/api/settings', input)
  }
  listDirectories(path?: string) {
    return this.get(`/api/fs${path ? `?path=${encodeURIComponent(path)}` : ''}`)
  }
  listHarnesses() {
    return this.get('/api/harnesses')
  }
  saveHarnesses(harness: Record<string, unknown>) {
    return this.put('/api/harnesses', { harness })
  }
  testHarness(name: string, harness?: unknown) {
    return this.post('/api/harnesses/test', null, { name, harness })
  }
  listRuns() {
    return this.get('/api/epics')
  }
  startRun(input: EpicStart) {
    return this.post('/api/epics/start', null, input)
  }
  getRun(runId: string) {
    return this.get(`/api/epics/${encodeURIComponent(runId)}`)
  }
  runAction(
    runId: string,
    action: 'pause' | 'resume' | 'cancel',
    options: { skipBead?: string } = {},
  ) {
    return this.post(
      `/api/epics/${encodeURIComponent(runId)}/${action}`,
      null,
      options,
    )
  }
  renameSession(sessionId: string, title: string) {
    return this.post(`/api/sessions/${encodeURIComponent(sessionId)}`, null, {
      title,
    })
  }
  settleSession(sessionId: string, settled: boolean) {
    return this.post(
      `/api/sessions/${encodeURIComponent(sessionId)}/settle`,
      null,
      { settled },
    )
  }
  deleteSession(sessionId: string) {
    return this.request(
      'DELETE',
      `/api/sessions/${encodeURIComponent(sessionId)}`,
    )
  }
  prompt(input: Prompt) {
    return this.post(`/api/sessions/${input.sessionId}/prompt`, prompt, input)
  }
  promoteDraft(input: PromoteDraft, requestId: string) {
    return this.post(
      `/api/drafts/${encodeURIComponent(input.draftId)}/promote`,
      null,
      input,
      requestId,
    )
  }
  async upload(
    sessionId: string,
    file: File,
    onProgress?: UploadProgress,
    projectId?: string,
  ) {
    const path = projectId
      ? `/api/drafts/${encodeURIComponent(sessionId)}/uploads`
      : `/api/sessions/${encodeURIComponent(sessionId)}/uploads`
    const init = (await this.post(
      path,
      null,
      {
        filename: file.name,
        mime: file.type || 'application/octet-stream',
        sizeBytes: file.size,
      },
      undefined,
      projectId ? { 'X-Project-Id': projectId } : undefined,
    )) as { attachmentId: string; putUrl: string }
    await putUpload(init, file, this.baseUrl, onProgress)
    onProgress?.(1)
    return init
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
      `/api/sessions/${input.sessionId}/questions/${input.questionId}/answer`,
      answerQuestion,
      input,
    )
  }
  cancelQuestion(input: { sessionId: string; questionId: string }) {
    return this.post(
      `/api/sessions/${input.sessionId}/questions/${input.questionId}/cancel`,
      cancelQuestion,
      input,
    )
  }
  fork(input: Fork) {
    return this.post(`/api/sessions/${input.sessionId}/fork`, fork, input)
  }
  btw(input: Btw) {
    return this.post(`/api/sessions/${input.sessionId}/btw`, btw, input)
  }
  private async post(
    path: string,
    schema: BodySchema | null,
    body: unknown,
    stableRequestId?: string,
    extraHeaders?: Record<string, string>,
  ) {
    const data = schema ? schema.parse(body) : body
    const requestId = stableRequestId ?? makeRequestId()
    for (let attempt = 0; ; attempt++) {
      let response: Response
      try {
        response = await this.fetcher(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'Idempotency-Key': requestId,
            ...extraHeaders,
          },
          body: JSON.stringify(data),
        })
      } catch (error) {
        if (attempt >= 1) throw error
        continue
      }
      if (!response.ok) throw await apiError(response)
      return await response.json()
    }
  }
  private async get(path: string) {
    const response = await this.fetcher(`${this.baseUrl}${path}`)
    if (!response.ok) throw await apiError(response)
    return await response.json()
  }
  private async request(method: string, path: string) {
    const response = await this.fetcher(`${this.baseUrl}${path}`, { method })
    if (!response.ok) throw await apiError(response)
    return await response.json()
  }
  private async put(path: string, body: unknown) {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw await apiError(response)
    return await response.json()
  }
}
export const api = new ForgeApi()

// The server answers failures with { error: string }; show that text instead
// of a bare status so users see the real cause.
async function apiError(response: Response) {
  let detail = ''
  try {
    const body = await response.json()
    if (body && typeof body.error === 'string') detail = `: ${body.error}`
  } catch {
    // Non-JSON failure body; the status alone has to do.
  }
  return new Error(`Forge API request failed (${response.status})${detail}`)
}

function makeRequestId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
}
