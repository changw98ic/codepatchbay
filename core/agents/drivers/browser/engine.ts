// @ts-nocheck
import { chromium } from "playwright"
import path from "node:path"
import os from "node:os"
import { mkdir } from "node:fs/promises"
import { loadProvider } from "./provider-loader.js"
import { fillPrompt, submitPrompt } from "./input-controller.js"
import { waitForFinalResponse, checkSelectorVisible } from "./response-waiter.js"
import { saveDiagnostic } from "./diagnostics.js"
import { BrowserAgentLoginRequiredError, BrowserAgentTimeoutError, BrowserAgentOutputEmptyError } from "./errors.js"
import { globalSessionManager } from "./session-store.js"

const PROFILE_ROOT = path.join(os.homedir(), ".cpb", "browser-agents")

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
}

export async function executeBrowserAgent({
  providerName,
  prompt,
  timeoutMs = 900_000,
  headless = false,
  trace = false,
  signal,
}) {
  const startTime = Date.now()

  // 1. Load provider profile
  const provider = await loadProvider(providerName)

  // 2. Acquire browser session via session manager
  const sessionHandle = await globalSessionManager.acquire({
    providerName,
    headless,
  })

  const { page, context } = sessionHandle
  let resultText = ""
  let tracePath = null
  let continueClicks = 0
  let completed = false

  try {
    if (trace) {
      tracePath = path.join(PROFILE_ROOT, providerName, `trace-${Date.now()}.zip`)
      await context.tracing.start({ screenshots: true, snapshots: true })
    }

    // 3. Navigate to provider URL
    await page.goto(provider.startUrl, { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(2000)

    // 4. Check login
    const loginVisible = await checkSelectorVisible(page, provider.auth.loginCheck.selector, 3000)
    if (loginVisible) {
      throw new BrowserAgentLoginRequiredError(
        providerName,
        `Provider "${providerName}" requires login. Please log in at ${provider.auth.loginUrl}`
      )
    }

    // 5. Wait for readyCheck selector
    await page.waitForSelector(provider.auth.readyCheck.selector, {
      state: "visible",
      timeout: 30000,
    })

    // 6. Fill prompt
    await fillPrompt(page, provider, prompt)

    // 7. Submit
    await submitPrompt(page, provider)

    // 8-9. Wait for response
    const response = await waitForFinalResponse(page, provider, {
      signal,
      timeoutMs: Math.min(provider.response.maxWaitMs || 900_000, timeoutMs),
    })

    resultText = response.text
    continueClicks = response.continueClicks

    if (!resultText || resultText.length < (provider.response.minChars || 10)) {
      throw new BrowserAgentOutputEmptyError(providerName)
    }

    // 10. Save trace
    if (trace && tracePath) {
      await context.tracing.stop({ path: tracePath })
    }
    completed = true
  } catch (err) {
    if (trace && tracePath) {
      try {
        await context.tracing.stop({ path: tracePath })
      } catch {}
    }
    if (provider?.diagnostics?.screenshotOnFailure && page) {
      try {
        await saveDiagnostic({ provider: providerName, error: err, page })
      } catch {}
    }
    throw err
  } finally {
    await globalSessionManager.release(sessionHandle, { promoteAuthState: completed })
  }

  const elapsedMs = Date.now() - startTime

  return {
    text: resultText,
    diagnostics: {
      provider: providerName,
      elapsedMs,
      profileDir: sessionHandle.profileDir,
      responseChars: resultText.length,
      continueClicks,
      tracePath,
    },
  }
}
