import path from "node:path"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"

const AUTH_STATE_FILE = "auth-state.json"
const AUTH_STATE_LOCK_DIR = ".auth-state.lock"
const LOCK_STALE_MS = 30_000
const LOCK_TIMEOUT_MS = 5_000
const LOCK_POLL_MS = 50

function authStatePath(baseProfileDir) {
  return path.join(baseProfileDir, AUTH_STATE_FILE)
}

function authStateLockPath(baseProfileDir) {
  return path.join(path.dirname(baseProfileDir), AUTH_STATE_LOCK_DIR)
}

function normalizeCookie(cookie) {
  if (!cookie || typeof cookie !== "object") return null
  if (!cookie.name || cookie.value == null) return null
  if (!cookie.domain && !cookie.url) return null
  return { ...cookie }
}

function normalizeOrigin(origin) {
  if (!origin || typeof origin !== "object" || !origin.origin) return null
  const localStorage = Array.isArray(origin.localStorage)
    ? origin.localStorage
      .filter((item) => item?.name && item.value != null)
      .map((item) => ({ name: String(item.name), value: String(item.value) }))
    : []
  return { origin: String(origin.origin), localStorage }
}

export function normalizeAuthState(state) {
  return {
    cookies: Array.isArray(state?.cookies)
      ? state.cookies.map(normalizeCookie).filter(Boolean)
      : [],
    origins: Array.isArray(state?.origins)
      ? state.origins.map(normalizeOrigin).filter(Boolean)
      : [],
  }
}

export async function loadAuthState(baseProfileDir) {
  try {
    const parsed = JSON.parse(await readFile(authStatePath(baseProfileDir), "utf8"))
    return normalizeAuthState(parsed)
  } catch {
    return null
  }
}

async function writeAuthState(baseProfileDir, state) {
  const file = authStatePath(baseProfileDir)
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(tmp, `${JSON.stringify(normalizeAuthState(state), null, 2)}\n`, "utf8")
  await rename(tmp, file)
}

function cookieKey(cookie) {
  return `${cookie.domain || cookie.url || ""}\u0000${cookie.path || ""}\u0000${cookie.name || ""}`
}

function cookieExpiry(cookie) {
  const expires = Number(cookie?.expires)
  return Number.isFinite(expires) ? expires : -1
}

function sameCookie(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null)
}

function chooseCookie({ base, current, runtime }) {
  if (!runtime) return current || null
  if (!current) return runtime

  if (base && sameCookie(runtime, base) && !sameCookie(current, base)) {
    return current
  }

  return cookieExpiry(current) > cookieExpiry(runtime) ? current : runtime
}

function cookiesByKey(cookies = []) {
  const map = new Map()
  for (const cookie of cookies) map.set(cookieKey(cookie), cookie)
  return map
}

function mergeCookies(base, current, runtime) {
  const baseByKey = cookiesByKey(base)
  const currentByKey = cookiesByKey(current)
  const runtimeByKey = cookiesByKey(runtime)
  const keys = new Set([...currentByKey.keys(), ...runtimeByKey.keys()])
  const merged = []

  for (const key of keys) {
    const cookie = chooseCookie({
      base: baseByKey.get(key),
      current: currentByKey.get(key),
      runtime: runtimeByKey.get(key),
    })
    if (cookie) merged.push(cookie)
  }

  merged.sort((a, b) => cookieKey(a).localeCompare(cookieKey(b)))
  return merged
}

function originStorageMap(origins = []) {
  const map = new Map()
  for (const origin of origins) {
    const storage = new Map()
    for (const item of origin.localStorage || []) storage.set(item.name, item.value)
    map.set(origin.origin, storage)
  }
  return map
}

function mergeOrigins(base, current, runtime) {
  const baseByOrigin = originStorageMap(base)
  const currentByOrigin = originStorageMap(current)
  const runtimeByOrigin = originStorageMap(runtime)
  const origins = new Set([...currentByOrigin.keys(), ...runtimeByOrigin.keys()])
  const merged = []

  for (const origin of origins) {
    const baseStorage = baseByOrigin.get(origin) || new Map()
    const currentStorage = currentByOrigin.get(origin) || new Map()
    const runtimeStorage = runtimeByOrigin.get(origin) || new Map()
    const names = new Set([...currentStorage.keys(), ...runtimeStorage.keys()])
    const localStorage = []

    for (const name of names) {
      const baseValue = baseStorage.get(name)
      const currentValue = currentStorage.get(name)
      const runtimeValue = runtimeStorage.get(name)

      let value
      if (runtimeValue === undefined) value = currentValue
      else if (currentValue === undefined) value = runtimeValue
      else if (baseValue !== undefined && runtimeValue === baseValue && currentValue !== baseValue) value = currentValue
      else value = runtimeValue

      if (value !== undefined) localStorage.push({ name, value })
    }

    localStorage.sort((a, b) => a.name.localeCompare(b.name))
    if (localStorage.length > 0) merged.push({ origin, localStorage })
  }

  merged.sort((a, b) => a.origin.localeCompare(b.origin))
  return merged
}

export function mergeAuthStates({ base, current, runtime }) {
  const normalizedBase = normalizeAuthState(base)
  const normalizedCurrent = normalizeAuthState(current)
  const normalizedRuntime = normalizeAuthState(runtime)

  return {
    cookies: mergeCookies(
      normalizedBase.cookies,
      normalizedCurrent.cookies,
      normalizedRuntime.cookies,
    ),
    origins: mergeOrigins(
      normalizedBase.origins,
      normalizedCurrent.origins,
      normalizedRuntime.origins,
    ),
  }
}

async function lockIsStale(lockDir) {
  try {
    const info = await stat(lockDir)
    return Date.now() - info.mtimeMs >= LOCK_STALE_MS
  } catch {
    return true
  }
}

async function withAuthStateLock(baseProfileDir, callback) {
  const lockDir = authStateLockPath(baseProfileDir)
  const startedAt = Date.now()

  for (;;) {
    try {
      await mkdir(lockDir)
      await writeFile(
        path.join(lockDir, "owner.json"),
        `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
        "utf8",
      )
      break
    } catch (err) {
      if (err?.code !== "EEXIST") throw err
      if (await lockIsStale(lockDir)) {
        await rm(lockDir, { recursive: true, force: true }).catch(() => {})
        continue
      }
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error(`auth state lock busy: ${path.basename(lockDir)}`)
      }
      await delay(LOCK_POLL_MS)
    }
  }

  try {
    return await callback()
  } finally {
    await rm(lockDir, { recursive: true, force: true }).catch(() => {})
  }
}

export async function applyAuthStateToContext(context, state) {
  const authState = normalizeAuthState(state)
  if (authState.cookies.length > 0) {
    await context.addCookies(authState.cookies.map((cookie) => {
      if (cookie.expires !== -1) return cookie
      const { expires: _expires, ...sessionCookie } = cookie
      return sessionCookie
    }))
  }
  if (authState.origins.length > 0) {
    await context.addInitScript((origins) => {
      const current = origins.find((origin) => origin.origin === window.location.origin)
      if (!current) return
      for (const item of current.localStorage || []) {
        window.localStorage.setItem(item.name, item.value)
      }
    }, authState.origins)
  }
}

export async function promoteAuthState({ baseProfileDir, baseAuthState, runtimeAuthState }) {
  const runtime = normalizeAuthState(runtimeAuthState)
  return withAuthStateLock(baseProfileDir, async () => {
    const current = await loadAuthState(baseProfileDir)
    const merged = mergeAuthStates({ base: baseAuthState, current, runtime })
    await writeAuthState(baseProfileDir, merged)
    return merged
  })
}

export async function promoteContextAuthState({ baseProfileDir, baseAuthState, context }) {
  const runtimeAuthState = await context.storageState()
  return promoteAuthState({ baseProfileDir, baseAuthState, runtimeAuthState })
}
