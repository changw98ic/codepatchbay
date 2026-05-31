import { chromium } from "playwright"
import path from "node:path"
import os from "node:os"
import { mkdir } from "node:fs/promises"
import { loadProvider } from "./provider-loader.mjs"
import { fillPrompt, submitPrompt } from "./input-controller.mjs"
import { waitForFinalResponse, checkSelectorVisible } from "./response-waiter.mjs"
import { saveDiagnostic } from "./diagnostics.mjs"
import { BrowserAgentLoginRequiredError, BrowserAgentTimeoutError, BrowserAgentOutputEmptyError } from "./errors.mjs"

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

  // 2. Create persistent browser context
  const profileDir = path.join(PROFILE_ROOT, providerName, "profile-0")
  await ensureDir(profileDir)

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: Boolean(headless),
    args: ["--disable-blink-features=AutomationControlled"],
  })

  let page
  let resultText = ""
  let tracePath = null
  let continueClicks = 0

  try {
    if (trace) {
      tracePath = path.join(PROFILE_ROOT, providerName, `trace-${Date.now()}.zip`)
      await context.tracing.start({ screenshots: true, snapshots: true })
    }

    // 3. Open page
    const pages = context.pages()
    page = pages.length > 0 ? pages[0] : await context.newPage()

    // 4. Navigate to provider URL
    await page.goto(provider.startUrl, { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(2000)

    // 5. Check login
    const loginVisible = await checkSelectorVisible(page, provider.auth.loginCheck.selector, 3000)
    if (loginVisible) {
      throw new BrowserAgentLoginRequiredError(
        providerName,
        `Provider "${providerName}" requires login. Please log in at ${provider.auth.loginUrl}`
      )
    }

    // 6. Wait for readyCheck selector
    await page.waitForSelector(provider.auth.readyCheck.selector, {
      state: "visible",
      timeout: 30000,
    })

    // 7. Fill prompt
    await fillPrompt(page, provider, prompt)

    // 8. Submit
    await submitPrompt(page, provider)

    // 9-10. Wait for response
    const response = await waitForFinalResponse(page, provider, {
      signal,
      timeoutMs: Math.min(provider.response.maxWaitMs || 900_000, timeoutMs),
    })

    resultText = response.text
    continueClicks = response.continueClicks

    if (!resultText || resultText.length < (provider.response.minChars || 10)) {
      throw new BrowserAgentOutputEmptyError(providerName)
    }

    // 11. Save context state
    if (trace && tracePath) {
      await context.tracing.stop({ path: tracePath })
    }
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
    await context.close()
  }

  const elapsedMs = Date.now() - startTime

  return {
    text: resultText,
    diagnostics: {
      provider: providerName,
      elapsedMs,
      profileDir,
      responseChars: resultText.length,
      continueClicks,
      tracePath,
    },
  }
}
