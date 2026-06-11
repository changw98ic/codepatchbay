import { chromium } from "playwright"
import path from "node:path"
import os from "node:os"
import { randomUUID } from "node:crypto"
import { cp, mkdir, rm } from "node:fs/promises"
import { applyAuthStateToContext, loadAuthState, promoteContextAuthState } from "./auth-state.js"

type BrowserSessionHandle = Record<string, any>

const DEFAULT_PROFILE_ROOT = path.join(os.homedir(), ".cpb", "browser-agents")
const BASE_PROFILE_DIR = "profile-0"
const RUNTIME_PROFILES_DIR = "runtime-profiles"
const CHROME_VOLATILE_NAMES = new Set([
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
  "DevToolsActivePort",
  "Crashpad",
  "BrowserMetrics",
  "Cache",
  "Code Cache",
  "GPUCache",
  "ShaderCache",
  "GrShaderCache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "LOCK",
])

function shouldUseRuntimeProfiles(env = process.env) {
  return env.CPB_BROWSER_AGENT_PROFILE_MODE !== "shared"
}

function shouldKeepRuntimeProfiles(env = process.env) {
  return env.CPB_BROWSER_AGENT_KEEP_RUNTIME_PROFILES === "1"
}

function shouldCopyProfilePath(profileDir, src) {
  const rel = path.relative(profileDir, src)
  if (!rel) return true
  return !rel.split(path.sep).some((part) => CHROME_VOLATILE_NAMES.has(part))
}

export class BrowserSessionManager {
  _optsProfileRoot: string | null
  contexts: Map<string, BrowserSessionHandle>

  constructor(opts = {}) {
    this._optsProfileRoot = (opts as Record<string, any>).profileRoot || null
    this.contexts = new Map() // id -> { id, providerName, context, page, role, project, createdAt }
  }

  _resolveProfileRoot() {
    return this._optsProfileRoot || process.env.CPB_ACP_BROWSER_AGENT_PROFILE_ROOT || DEFAULT_PROFILE_ROOT
  }

  async _prepareProfile(providerName) {
    const providerRoot = path.join(this._resolveProfileRoot(), providerName)
    const baseProfileDir = path.join(providerRoot, BASE_PROFILE_DIR)
    await mkdir(baseProfileDir, { recursive: true })
    const baseAuthState = await loadAuthState(baseProfileDir)

    if (!shouldUseRuntimeProfiles()) {
      return { profileDir: baseProfileDir, baseProfileDir, runtimeProfileDir: null, baseAuthState }
    }

    const runtimeProfileDir = path.join(
      providerRoot,
      RUNTIME_PROFILES_DIR,
      `${Date.now()}-${process.pid}-${randomUUID()}`
    )
    await mkdir(path.dirname(runtimeProfileDir), { recursive: true })
    await cp(baseProfileDir, runtimeProfileDir, {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: (src) => shouldCopyProfilePath(baseProfileDir, src),
    })

    return { profileDir: runtimeProfileDir, baseProfileDir, runtimeProfileDir, baseAuthState }
  }

  async acquire({ providerName, sessionId, role, project, headless = false }) {
    const { profileDir, baseProfileDir, runtimeProfileDir, baseAuthState } = await this._prepareProfile(providerName)

    let context
    try {
      context = await chromium.launchPersistentContext(profileDir, {
        headless: Boolean(headless),
        args: ["--disable-blink-features=AutomationControlled"],
      })
      if (baseAuthState) {
        await applyAuthStateToContext(context, baseAuthState)
      }
    } catch (err) {
      if (runtimeProfileDir && !shouldKeepRuntimeProfiles()) {
        await rm(runtimeProfileDir, { recursive: true, force: true }).catch(() => {})
      }
      throw err
    }

    const pages = context.pages()
    const page = pages.length > 0 ? pages[0] : await context.newPage()

    const handle = {
      id: sessionId || `${providerName}-${Date.now()}`,
      providerName,
      context,
      page,
      role,
      project,
      profileDir,
      baseProfileDir,
      runtimeProfileDir,
      baseAuthState,
      createdAt: Date.now(),
    }

    this.contexts.set(handle.id, handle)
    return handle
  }

  async release(handle, { promoteAuthState = false } = {}) {
    if (!handle) return
    this.contexts.delete(handle.id)
    if (promoteAuthState && handle.context && handle.baseProfileDir) {
      try {
        await promoteContextAuthState({
          baseProfileDir: handle.baseProfileDir,
          baseAuthState: handle.baseAuthState,
          context: handle.context,
        })
      } catch (err) {
        handle.authStatePromotionError = err
      }
    }
    try {
      await handle.context.close()
    } catch {}
    if (handle.runtimeProfileDir && !shouldKeepRuntimeProfiles()) {
      await rm(handle.runtimeProfileDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  async closeProvider(providerName) {
    for (const [id, handle] of this.contexts.entries()) {
      if (handle.providerName === providerName) {
        await this.release(handle)
      }
    }
  }

  async shutdown() {
    for (const handle of this.contexts.values()) {
      await this.release(handle)
    }
  }
}

export const globalSessionManager = new BrowserSessionManager()
