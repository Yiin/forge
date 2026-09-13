import { setTimeout as delay } from 'node:timers/promises'

/** Only fixture startup and positive lock acquisition may use this helper. */
export async function retryFixtureAdmission<T>(
  work: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work()
    } catch (error) {
      const failure = error as { code?: string; uncertain?: boolean }
      // KimiHomeLock emits this code only when nonblocking flock refuses,
      // before native startup. Never retry a native prompt or an uncertain result.
      if (
        failure.code !== 'kimi_account_home_busy' ||
        failure.uncertain ||
        attempt === 9
      )
        throw error
      console.info(`Fixture pre-admission lock busy; retry ${attempt + 1}/9`)
      await delay(10)
    }
  }
}
