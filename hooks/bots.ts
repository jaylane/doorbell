import type { Author } from '../types'

export const isBot = (a: Author): boolean => a === null || a.__typename === 'Bot' || a.login.endsWith('[bot]')
