import { chromium } from "playwright"
import path from "node:path"
import os from "node:os"
import { mkdir } from "node:fs/promises"

const PROFILE_ROOT = path.join(os.homedir(), ".cpb", "browser-agents")

export class BrowserSessionManager {
  constructor() {
    this.contexts = new Map() // id -> { id, providerName, context, page, role, project, createdAt }
  }

  async acquire({ providerName, sessionId, role, project, headless = false }) {
    const profileDir = path.join(PROFILE_ROOT, providerName, "profile-0")
    await mkdir(profileDir, { recursive: true })

    const context = await chromium.launchPersistentContext(profileDir, {
      headless: Boolean(headless),
      args: ["--disable-blink-features=AutomationControlled"],
    })

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
      createdAt: Date.now(),
    }

    this.contexts.set(handle.id, handle)
    return handle
  }

  async release(handle) {
    if (!handle) return
    this.contexts.delete(handle.id)
    try {
      await handle.context.close()
    } catch {}
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
