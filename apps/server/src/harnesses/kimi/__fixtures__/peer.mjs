#!/usr/bin/env node
// Synthetic peer for the pinned Kimi Code 0.34.0 HTTP/WebSocket contract.
import { createServer as httpServer } from 'node:http'
import { createServer as ipcServer } from 'node:net'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { WebSocketServer } from 'ws'
import openapi from './openapi.json' with { type: 'json' }
import asyncapi from './asyncapi.json' with { type: 'json' }

const args = process.argv.slice(2)
if (
  args.length !== 6 ||
  args[0] !== 'web' ||
  args[1] !== '--no-open' ||
  args[2] !== '--host' ||
  args[3] !== '127.0.0.1' ||
  args[4] !== '--port'
)
  process.exit(2)
const home = process.env.KIMI_CODE_HOME
function identity(pid) {
  const value = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const fields = value.slice(value.lastIndexOf(')') + 2).split(' ')
  return { pid, startTicks: fields[19], pgid: Number(fields[2]) }
}
function evidence(phase, detail = {}) {
  const path = process.env.FORGE_KIMI_FIXTURE_OWNERSHIP_LOG
  if (!path) return
  if (!path.startsWith('/var/tmp/forge-comet-kimi-review-correction-v2-'))
    throw new Error('Fixture evidence path is outside its owned scope')
  appendFileSync(
    path,
    JSON.stringify({
      phase,
      home,
      testId: process.env.FORGE_KIMI_FIXTURE_TEST_ID,
      ...detail,
    }) + '\n',
    { mode: 0o600 },
  )
}
const original = identity(process.pid)
evidence('peer.started', {
  ...original,
  guardian: identity(process.ppid),
  boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
})
process.on('exit', (code) => evidence('peer.exit', { ...original, code }))
const token = await readFile(join(home, 'server.token'), 'utf8')
const sessions = new Map(),
  sockets = new Map(),
  requests = [],
  uploads = new Map()
let scenario = {},
  heldMessages = [],
  heldReplies = [],
  heldPrompts = [],
  heldSteers = [],
  heldStartup = []
try {
  const bytes = await readFile(join(home, 'fixture-scenario.json'))
  if (bytes.length > 65536) throw new Error('Fixture scenario limit')
  scenario = JSON.parse(bytes)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
if (scenario.banner) process.stderr.write(`Fixture private token: ${token}\n`)
function nested(depth) {
  let value = null
  for (let index = 0; index < depth; index++) value = { child: value }
  return value
}
function state(session) {
  return {
    id: session.id,
    metadata: { cwd: session.cwd },
    busy: !!session.active,
    agent_config: { model: '' },
    usage: {},
    message_count: session.messages.length,
    last_seq: session.seq,
  }
}
function transcriptState(session, agent = 'main') {
  if (!session.transcripts.has(agent))
    session.transcripts.set(agent, {
      seq: scenario.baseline?.seq ?? 0,
      batches: [],
      items: structuredClone(scenario.baseline?.items ?? []),
      global: structuredClone(scenario.baseline?.global ?? {}),
    })
  return session.transcripts.get(agent)
}
function frame(session, type, payload, volatile = false) {
  const envelope = {
    type,
    seq: volatile ? session.seq : ++session.seq,
    epoch: session.epoch,
    session_id: session.id,
    timestamp: '2026-09-11T00:00:00Z',
    ...(volatile ? { volatile: true } : {}),
    payload: { type, agentId: 'main', ...payload },
  }
  if (!volatile) session.events.push(envelope)
  for (const [ws, owner] of sockets)
    if (
      owner.session === session.id &&
      ((owner.role === 'life' && !type.startsWith('transcript.')) ||
        (owner.role === 'transcript' &&
          type.startsWith('transcript.') &&
          owner.grades?.[payload.agent_id] === 'delta'))
    )
      ws.send(JSON.stringify(envelope))
  return envelope
}
function addMessage(session, id, role, content, metadata) {
  session.messages.push({
    id,
    session_id: session.id,
    role,
    content,
    created_at: '2026-09-11T00:00:00Z',
    ...(metadata ? { metadata } : {}),
  })
}
function start(session, prompt) {
  session.active = prompt
  prompt.status = 'running'
  prompt.turn = session.turn++
  addMessage(session, prompt.user_message_id, 'user', prompt.content, {
    origin: { kind: 'user' },
  })
  frame(session, 'turn.started', {
    turnId: prompt.turn,
    origin: { kind: 'user' },
  })
  frame(session, 'turn.step.started', {
    turnId: prompt.turn,
    stepId: randomUUID(),
    step: 1,
  })
}
const server = httpServer(async (req, res) => {
  const id = req.headers['x-request-id']
  if (
    req.headers.authorization !== `Bearer ${token}` ||
    !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(id ?? '')
  ) {
    res.writeHead(401)
    res.end()
    return
  }
  const url = new URL(req.url, 'http://127.0.0.1'),
    parts = url.pathname.split('/').map(decodeURIComponent)
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const bytes = Buffer.concat(chunks)
  let body
  if (
    bytes.length &&
    req.headers['content-type']?.startsWith('application/json')
  )
    body = JSON.parse(bytes)
  requests.push({
    method: req.method,
    path: url.pathname,
    query: url.search,
    body,
    requestId: id,
  })
  const send = (data, code = 0) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        code,
        msg: code === 0 ? 'success' : 'native response',
        data,
        request_id: id,
      }),
    )
  }
  if (url.pathname === '/healthz') {
    if (scenario.holdHealth) {
      heldStartup.push(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
      })
      return
    }
    res.end(JSON.stringify({ ok: true }))
    return
  }
  if (url.pathname === '/openapi.json' || url.pathname === '/asyncapi.json') {
    res.end(
      JSON.stringify(
        scenario.schemaDepth
          ? nested(scenario.schemaDepth)
          : scenario.schemaNodes
            ? { extra: Array(scenario.schemaNodes).fill(null) }
            : url.pathname === '/openapi.json'
              ? openapi
              : asyncapi,
      ),
    )
    return
  }
  if (url.pathname === '/api/v1/meta') {
    send({
      server_version: scenario.version ?? '0.34.0',
      backend: 'v2',
      dangerous_bypass_auth: false,
      capabilities: { websocket: true },
      server_id: 'fixture-server',
      ...(scenario.ordinaryDepth
        ? { extra: nested(scenario.ordinaryDepth) }
        : {}),
    })
    return
  }
  if (url.pathname === '/api/v1/models') {
    send({
      items: [
        {
          model: 'fixture-model',
          provider: 'fixture',
          max_context_size: 100000,
          capabilities: ['image', 'video'],
          support_efforts: ['low', 'high'],
          default_effort: 'low',
        },
      ],
    })
    return
  }
  if (url.pathname === '/api/v1/config') {
    send({ providers: {}, default_model: 'fixture-model', thinking: 'low' })
    return
  }
  if (url.pathname === '/api/v1/files' && req.method === 'POST') {
    const boundary = req.headers['content-type']?.match(
      /^multipart\/form-data; boundary=(.+)$/,
    )?.[1]
    const split = bytes.indexOf('\r\n\r\n'),
      headers = bytes.subarray(0, split).toString('utf8')
    const name = headers.match(/filename="([^"\r\n]+)"/)?.[1],
      mime = headers.match(/Content-Type: ([^\r\n]+)/)?.[1]
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`)
    if (
      !boundary ||
      split < 0 ||
      !name ||
      !mime ||
      !bytes.subarray(-suffix.length).equals(suffix)
    ) {
      send(null, 40001)
      return
    }
    const fileId = randomUUID(),
      content = bytes.subarray(split + 4, -suffix.length)
    uploads.set(fileId, { bytes: content, name, mime })
    send({
      id: fileId,
      name,
      media_type: mime,
      size: content.length,
      created_at: 0,
    })
    return
  }
  if (parts[3] === 'files' && parts[4]) {
    if (req.method === 'DELETE') {
      uploads.delete(parts[4])
      send({ deleted: true })
    } else {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(
        scenario.rawBytes
          ? Buffer.alloc(scenario.rawBytes, 7)
          : (uploads.get(parts[4])?.bytes ?? Buffer.from([1, 2, 3])),
      )
    }
    return
  }
  if (url.pathname === '/api/v1/sessions' && req.method === 'POST') {
    const session = {
      id: `session_${sessions.size + 1}`,
      cwd: body.metadata.cwd,
      seq: 0,
      epoch: randomUUID(),
      turn: 0,
      events: [],
      messages: [],
      active: null,
      queued: [],
      questions: [],
      approvals: [],
      tx: 0,
      transcripts: new Map(),
    }
    sessions.set(session.id, session)
    send(state(session))
    return
  }
  const session = sessions.get(parts[4])
  if (!session) {
    send(null, 40401)
    return
  }
  const route = parts[5]
  if (!route) {
    send(state(session))
    return
  }
  if (route === 'snapshot') {
    send({
      as_of_seq: session.seq,
      epoch: session.epoch,
      session: state(session),
      messages: { items: [...session.messages], has_more: false },
      in_flight_turn: session.active
        ? {
            turn_id: session.active.turn,
            assistant_text: '',
            thinking_text: '',
            running_tools: [],
            current_prompt_id: session.active.prompt_id,
          }
        : null,
      subagents: [],
      pending_questions: [...session.questions],
      pending_approvals: [...session.approvals],
    })
    return
  }
  if (route === 'transcript') {
    const agent = url.searchParams.get('agent_id'),
      current = transcriptState(session, agent)
    if (parts[6] === 'plan') {
      const tool = url.searchParams.get('tool_call_id'),
        approval = session.approvals.find((item) => item.tool_call_id === tool)
      send({
        agent_id: agent,
        plans: approval
          ? [
              {
                tool_call_id: tool,
                turn_id: `t${approval.turn_id}`,
                source: 'interaction',
                plan: approval.tool_input_display.plan,
                options: approval.tool_input_display.options,
              },
            ]
          : [],
      })
      return
    }
    if (parts[6] === 'ops')
      send({
        agent_id: agent,
        batches: current.batches.filter(
          (batch) => batch.seq > Number(url.searchParams.get('since_seq')),
        ),
        latest_seq: current.seq,
        complete: scenario.incompleteTranscript !== true,
      })
    else {
      let items = current.items
      const before = url.searchParams.get('before_turn')
      if (before) {
        const index = items.findIndex(
          (item) => item.kind === 'turn' && item.turnId === before,
        )
        if (index < 0)
          throw new Error('Fixture before_turn is not an original turn')
        items = items.slice(0, index)
      }
      const turns = items.flatMap((item, index) =>
        item.kind === 'turn' ? [index] : [],
      )
      const count = Number(url.searchParams.get('page_size') ?? 20)
      const start = turns.length > count ? turns[turns.length - count] : 0
      send({
        agent_id: url.searchParams.get('agent_id'),
        items: items.slice(start),
        has_more: start > 0,
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        meta: {},
        agents: [],
        pending_interactions: [],
        ...current.global,
        seq: current.seq,
      })
    }
    return
  }
  if (route === 'messages') {
    const answer = () => {
      if (scenario.invalidMessageUtf8) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(Buffer.from([0x7b, 0xff, 0x7d]))
        return
      }
      if (scenario.messageEnvelopeBytes) {
        const content = [
          { type: 'text', text: '' },
          { type: 'text', text: '' },
        ]
        const data = {
          items: [
            {
              id: 'maximum-message',
              session_id: session.id,
              role: 'assistant',
              content,
              created_at: '2026-09-11T00:00:00Z',
            },
          ],
          has_more: false,
        }
        const remaining =
          scenario.messageEnvelopeBytes -
          Buffer.byteLength(
            JSON.stringify({ code: 0, msg: 'success', request_id: id, data }),
          )
        content[0].text = 'x'.repeat(Math.floor(remaining / 2))
        content[1].text = 'x'.repeat(Math.ceil(remaining / 2))
        send(data)
        return
      }
      let items = [...session.messages].reverse()
      if (scenario.removeAnchor && session.active === null)
        items = items.filter((item) => item.id !== scenario.removeAnchor)
      const before = url.searchParams.get('before_id')
      if (before) {
        const index = items.findIndex((message) => message.id === before)
        if (index >= 0) items = items.slice(index + 1)
      }
      const size = Number(url.searchParams.get('page_size') ?? 20)
      send({
        items: items.slice(0, scenario.excessiveMessagePage ? size + 1 : size),
        has_more: items.length > size,
      })
    }
    if (scenario.holdMessages) heldMessages.push(answer)
    else answer()
    return
  }
  if (route === 'prompts' && parts[6]?.endsWith(':abort')) {
    const promptId = parts[6].slice(0, -6)
    if (scenario.loseAbort) {
      req.socket.destroy()
      return
    }
    send({ prompt_id: promptId, aborted: true })
    if (!scenario.holdAbortTerminal) {
      frame(session, 'prompt.aborted', { promptId, abortedAt: '2026-09-11' })
      if (session.active?.prompt_id === promptId) session.active = null
      session.queued = session.queued.filter(
        (prompt) => prompt.prompt_id !== promptId,
      )
    }
    return
  }
  if (route === 'prompts' && req.method === 'GET') {
    send({ active: session.active, queued: session.queued })
    return
  }
  if (route === 'prompts' && req.method === 'POST') {
    const prompt = {
      prompt_id: randomUUID(),
      user_message_id: randomUUID(),
      status: 'queued',
      content: body.content,
      created_at: 0,
    }
    // Pinned implementation uses the same native identity for prompt and user message.
    prompt.user_message_id = prompt.prompt_id
    const publish = () => {
      if (scenario.blocked) {
        prompt.status = 'blocked'
        frame(session, 'prompt.completed', {
          promptId: prompt.prompt_id,
          reason: 'blocked',
        })
      } else if (session.active || scenario.queued) session.queued.push(prompt)
      else start(session, prompt)
      if (scenario.losePost) {
        req.socket.destroy()
        return
      }
      send(prompt)
    }
    if (scenario.holdNextPrompt) {
      scenario.holdNextPrompt = false
      heldPrompts.push(publish)
    } else publish()
    return
  }
  if (route === 'prompts:steer') {
    const selected = session.queued.filter((prompt) =>
      body.prompt_ids.includes(prompt.prompt_id),
    )
    session.queued = session.queued.filter(
      (prompt) => !body.prompt_ids.includes(prompt.prompt_id),
    )
    addMessage(
      session,
      `steering-context-${randomUUID()}`,
      'user',
      selected.flatMap((prompt) => prompt.content),
      { origin: { kind: 'user' } },
    )
    frame(session, 'prompt.steered', {
      activePromptId: session.active.prompt_id,
      promptIds: selected.map((prompt) => prompt.prompt_id),
      content: selected.flatMap((prompt) => prompt.content),
      steeredAt: '2026-09-11',
    })
    const answer = () => send({ steered: true, prompt_ids: body.prompt_ids })
    if (scenario.holdSteer) heldSteers.push(answer)
    else answer()
    return
  }
  if (route === 'questions' || route === 'approvals') {
    if (req.method === 'GET') {
      send({ items: session[route] })
      return
    }
    const kind = route === 'questions' ? 'question' : 'approval',
      nativeId = parts[6].replace(/:dismiss$/, '')
    const answer = () => {
      session[route] = session[route].filter(
        (item) => item[`${kind}_id`] !== nativeId,
      )
      if (scenario.loseReply) {
        req.socket.destroy()
        return
      }
      send(
        parts[6].endsWith(':dismiss')
          ? { dismissed: true }
          : { resolved: true, resolved_at: '2026-09-11T00:00:00Z' },
        parts[6].endsWith(':dismiss') ? 40909 : 0,
      )
    }
    if (scenario.holdReplies) heldReplies.push(answer)
    else answer()
    return
  }
  send(null, 40401)
})
const wsServer = new WebSocketServer({
  server,
  path: '/api/v1/ws',
  perMessageDeflate: false,
  handleProtocols: (protocols) =>
    protocols.has(`kimi-code.bearer.${token}`)
      ? `kimi-code.bearer.${token}`
      : false,
})
wsServer.on('connection', (ws) => {
  sockets.set(ws, {})
  ws.send(
    JSON.stringify({ type: 'server_hello', payload: { protocol_version: 2 } }),
  )
  ws.on('close', () => sockets.delete(ws))
  ws.on('message', (bytes) => {
    const message = JSON.parse(bytes),
      payload = message.payload
    const ack = (data) =>
      ws.send(
        JSON.stringify({
          type: 'ack',
          id: message.id,
          code: 0,
          msg: 'success',
          payload: data,
        }),
      )
    if (message.type === 'client_hello') {
      ack({ accepted: [], resync_required: [], cursors: {} })
      return
    }
    if (message.type === 'subscribe' || message.type === 'subscribe_v2') {
      const id = payload.session_id ?? payload.session_ids[0],
        session = sessions.get(id)
      sockets.set(ws, {
        session: id,
        role: message.type === 'subscribe' ? 'life' : 'transcript',
        grades: payload.transcript,
      })
      if (message.type === 'subscribe') {
        for (const event of session.events)
          if (event.seq > (payload.cursors?.[id]?.seq ?? session.seq))
            ws.send(JSON.stringify(event))
      } else
        for (const [agent, current] of session.transcripts) {
          if (payload.transcript[agent] !== 'delta') continue
          for (const batch of current.batches)
            if (batch.seq > (payload.transcript_since?.[agent] ?? current.seq))
              ws.send(
                JSON.stringify({
                  type: 'transcript.ops',
                  session_id: id,
                  seq: session.seq,
                  epoch: session.epoch,
                  volatile: true,
                  payload: {
                    type: 'transcript.ops',
                    agent_id: agent,
                    ...batch,
                  },
                }),
              )
        }
      ack({
        accepted: [id],
        not_found: [],
        resync_required: [],
        cursors: { [id]: { seq: session.seq, epoch: session.epoch } },
      })
      return
    }
  })
})
await writeFile(join(home, 'fixture.ready'), String(process.pid))
await new Promise((resolve) =>
  server.listen(Number(args[5]), '127.0.0.1', resolve),
)
const controlPath = join(home, 'fixture.sock')
const control = ipcServer((socket) => {
  let buffer = ''
  socket.on('data', async (bytes) => {
    buffer += bytes
    const newline = buffer.indexOf('\n')
    if (newline < 0) return
    const command = JSON.parse(buffer.slice(0, newline)),
      session = sessions.get(command.sessionId)
    let result = {}
    if (command.op === 'inspect')
      result = {
        pid: process.pid,
        cwd: process.cwd(),
        port: server.address().port,
        sessions: [...sessions.values()].map((s) => ({
          id: s.id,
          cwd: s.cwd,
          active: s.active,
          seq: s.seq,
        })),
        requests,
        uploads: [...uploads.entries()].map(([id, file]) => ({
          id,
          name: file.name,
          mime: file.mime,
          data: file.bytes.toString('base64'),
        })),
        sockets: [...sockets.values()].map(({ session, role, grades }) => ({
          session,
          role,
          grades,
        })),
      }
    else if (command.op === 'scenario')
      scenario = { ...scenario, ...command.value }
    else if (command.op === 'releaseStartup') {
      scenario.holdHealth = false
      heldStartup.splice(0).forEach((answer) => answer())
    } else if (command.op === 'releaseMessages') {
      scenario.holdMessages = false
      heldMessages.splice(0).forEach((answer) => answer())
    } else if (command.op === 'releaseReplies') {
      scenario.holdReplies = false
      heldReplies.splice(0).forEach((answer) => answer())
    } else if (command.op === 'releasePrompts') {
      heldPrompts.splice(0).forEach((answer) => answer())
    } else if (command.op === 'releaseSteers') {
      scenario.holdSteer = false
      heldSteers.splice(0).forEach((answer) => answer())
    } else if (command.op === 'frame') {
      const pending = { ...command.payload }
      delete pending.agentId
      delete pending.sessionId
      delete pending.type
      if (command.type === 'event.question.requested')
        session.questions.push(pending)
      if (command.type === 'event.approval.requested')
        session.approvals.push(pending)
      frame(session, command.type, command.payload, command.volatile)
    } else if (command.op === 'baseline') {
      const current = transcriptState(session, command.agentId ?? 'main')
      current.seq = command.seq
      current.items = command.items
      current.global = command.global ?? {}
      current.batches = []
    } else if (command.op === 'transcript') {
      const agent = command.agentId ?? 'main',
        current = transcriptState(session, agent),
        seq = command.seq ?? current.seq + 1
      current.seq = Math.max(current.seq, seq)
      current.batches.push({ seq, ops: command.ops })
      if (!command.hidden)
        frame(
          session,
          'transcript.ops',
          { agent_id: agent, seq, ops: command.ops },
          true,
        )
    } else if (command.op === 'closeSockets') {
      for (const [ws, owner] of sockets)
        if (
          owner.session === session.id &&
          (!command.role || owner.role === command.role)
        )
          ws.terminate()
    } else if (command.op === 'resync') {
      for (const [ws, owner] of sockets)
        if (owner.session === session.id && owner.role === 'life')
          ws.send(
            JSON.stringify({
              type: 'resync_required',
              timestamp: '2026-09-11T00:00:00Z',
              payload: {
                session_id: session.id,
                reason: command.reason,
                current_seq: session.seq,
                epoch: session.epoch,
              },
            }),
          )
    } else if (command.op === 'message')
      addMessage(
        session,
        command.id,
        command.role,
        command.content,
        command.metadata,
      )
    else if (command.op === 'finish') {
      const active = session.active
      if (command.content)
        addMessage(
          session,
          `msg_${session.id}_${String(session.messages.length).padStart(6, '0')}`,
          'assistant',
          command.content,
        )
      frame(session, 'turn.ended', {
        turnId: active.turn,
        reason: command.reason ?? 'completed',
      })
      frame(session, 'prompt.completed', {
        promptId: active.prompt_id,
        reason: command.reason ?? 'completed',
      })
      session.active = null
    } else if (command.op === 'spawn_descendant') {
      const child = spawn(
        process.execPath,
        [new URL('./writer.mjs', import.meta.url).pathname],
        { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
      )
      await new Promise((resolve, reject) => {
        child.once('message', resolve)
        child.once('error', reject)
      })
      evidence('peer.descendant', { original: identity(child.pid) })
      result = { pid: child.pid }
    } else if (command.op === 'exit') {
      socket.end('{}\n')
      setImmediate(() => process.exit(command.code ?? 0))
      return
    }
    socket.end(JSON.stringify(result) + '\n')
  })
})
await new Promise((resolve) => control.listen(controlPath, resolve))
process.on('SIGTERM', () => {
  evidence('peer.sigterm', { ...original, held: !!scenario.holdShutdown })
  if (scenario.holdShutdown) return
  for (const ws of sockets.keys()) ws.terminate()
  control.close()
  server.close()
  wsServer.close()
  void unlink(controlPath).catch(() => {})
})
