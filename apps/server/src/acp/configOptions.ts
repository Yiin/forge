import type * as acp from '@zed-industries/agent-client-protocol'
import type {
  AnyMessage,
  AnyResponse,
} from '@zed-industries/agent-client-protocol/dist/jsonrpc.js'

export type SessionConfigOption =
  | {
      id: string
      name: string
      type: 'select'
      currentValue: string
      options:
        | Array<{ value: string; name: string; description?: string }>
        | Array<{
            group: string
            name: string
            options: Array<{
              value: string
              name: string
              description?: string
            }>
          }>
      description?: string
      category?: 'mode' | 'model' | 'thought_level' | string
    }
  | {
      id: string
      name: string
      type: 'boolean'
      currentValue: boolean
      description?: string
      category?: 'mode' | 'model' | 'thought_level' | string
    }

type Hooks = {
  onConfigOptions(sessionId: string, options: SessionConfigOption[]): void
}

const isResponse = (message: AnyMessage): message is AnyResponse =>
  'id' in message && !('method' in message)

export function createConfigOptionChannel(base: acp.Stream, hooks: Hooks) {
  let nextId = 0
  const pending = new Map<
    string,
    {
      resolve: (options: SessionConfigOption[]) => void
      reject: (error: unknown) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  const reader = base.readable.getReader()
  const writer = base.writable.getWriter()
  let writeQueue = Promise.resolve()

  const readable = new ReadableStream<AnyMessage>({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          for (const item of pending.values()) {
            clearTimeout(item.timer)
            item.reject(new Error('ACP stream closed'))
          }
          pending.clear()
          controller.close()
          return
        }
        if (
          isResponse(value) &&
          typeof value.id === 'string' &&
          pending.has(value.id)
        ) {
          const item = pending.get(value.id)!
          pending.delete(value.id)
          clearTimeout(item.timer)
          if ('error' in value) item.reject(new Error(value.error.message))
          else {
            const result = value.result as {
              configOptions?: SessionConfigOption[]
            }
            item.resolve(result.configOptions ?? [])
          }
          continue
        }
        if ('method' in value && value.method === 'session/update') {
          const params = value.params as
            | {
                sessionId?: string
                update?: {
                  sessionUpdate?: string
                  configOptions?: SessionConfigOption[]
                }
              }
            | undefined
          if (
            params?.update?.sessionUpdate === 'config_option_update' &&
            typeof params.sessionId === 'string' &&
            Array.isArray(params.update.configOptions)
          ) {
            hooks.onConfigOptions(params.sessionId, params.update.configOptions)
            continue
          }
        }
        controller.enqueue(value)
        return
      }
    },
    cancel() {
      reader.releaseLock()
    },
  })

  const write = (message: AnyMessage) => {
    writeQueue = writeQueue.then(() => writer.write(message))
    return writeQueue
  }

  return {
    stream: { readable, writable: new WritableStream<AnyMessage>({ write }) },
    rejectPending(error: unknown) {
      for (const item of pending.values()) {
        clearTimeout(item.timer)
        item.reject(error)
      }
      pending.clear()
    },
    setConfigOption(
      sessionId: string,
      configId: string,
      value: string | boolean,
    ) {
      const id = `forge-cfg-${nextId++}`
      const params =
        typeof value === 'boolean'
          ? { sessionId, configId, type: 'boolean', value }
          : { sessionId, configId, value }
      return new Promise<SessionConfigOption[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error('Timed out waiting for session config option'))
        }, 15_000)
        pending.set(id, { resolve, reject, timer })
        void write({
          jsonrpc: '2.0',
          id,
          method: 'session/set_config_option',
          params,
        }).catch((error) => {
          pending.delete(id)
          clearTimeout(timer)
          reject(error)
        })
      })
    },
  }
}
