import type { Register } from 'claude-code'

import type { Io } from './io'

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    // Compile-time proof that `$` satisfies `Io`; the validator forbids reading `$` as a value.
    const assignable: typeof $ extends Io ? true : never = true
    void assignable
    return next(e)
  })
}
