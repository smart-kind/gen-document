import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Read and parse JSON, returning null when the file is missing or unreadable. */
export function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null
    return JSON.parse(readFileSync(filePath, 'utf8')) as T
  } catch {
    return null
  }
}

/**
 * Atomic write: write to `.tmp` then rename, so an interruption cannot leave a
 * half-written JSON document behind.
 */
export function writeJsonFile(filePath: string, data: unknown): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmpPath = `${filePath}.tmp`
  writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  renameSync(tmpPath, filePath)
}
