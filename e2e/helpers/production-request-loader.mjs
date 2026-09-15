import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Keep original module URLs so migrations and native package resolution use
// the production checkout. Only the test process installs this loader.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (error) {
      if (
        error.code === 'ERR_MODULE_NOT_FOUND' &&
        specifier.startsWith('.') &&
        specifier.endsWith('.js') &&
        context.parentURL?.startsWith('file:')
      ) {
        const candidate = new URL(
          specifier.slice(0, -3) + '.ts',
          context.parentURL,
        )
        if (existsSync(candidate)) return next(candidate.href, context)
      }
      throw error
    }
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.ts'))
      return {
        format: 'module',
        shortCircuit: true,
        source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), {
          mode: 'transform',
          sourceUrl: url,
        }),
      }
    return next(url, context)
  },
})
