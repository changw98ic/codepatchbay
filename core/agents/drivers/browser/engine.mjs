import { chromium } from "playwright"
import path from "node:path"
import os from "node:os"
import { mkdir } from "node:fs/promises"
import { loadProvider } from "./provider-loader.mjs"
import { LoginRequiredError } from "./profile-schema.mjs"

const PROFILE_ROOT = path.join(os.homedir(), ".cpb", "browser-agents")

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
}

async function checkSelectorVisible(page, selector, timeoutMs = 5000) {
  try {
    await page.waitForSelector(selector, { state: "visible", timeout: timeoutMs })
    return true
  } catch {
    return false
  }
}

async function checkSelectorHidden(page, selector, timeoutMs = 5000) {
  try {
    await page.waitForSelector(selector, { state: "hidden", timeout: timeoutMs })
    return true
  } catch {
    return false
  }
}

async function fillInput(page, provider, prompt) {
  const { input } = provider
  const el = await page.locator(input.selector).first()

  if (input.clearBeforeInput) {
    await el.fill("")
  }

  if (input.method === "fill") {
    await el.fill(prompt)
  } else if (input.method === "type") {
    await el.type(prompt)
  } else if (input.method === "paste") {
    await el.fill("")
    await page.evaluate(
      (sel, text) => {
        const el = document.querySelector(sel)
        if (!el) return
        if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
          el.value = text
        } else if (el.isContentEditable) {
          el.textContent = text
        }
        el.dispatchEvent(new Event("input", { bubbles: true }))
        el.dispatchEvent(new Event("change", { bubbles: true }))
      },
      input.selector,
      prompt
    )
  }
}

async function submitInput(page, provider) {
  const { submit } = provider.input
  if (submit.mode === "button" && submit.selector) {
    const btn = page.locator(submit.selector).first()
    await btn.click()
  } else if (submit.mode === "enter") {
    await page.keyboard.press("Enter")
  } else if (submit.mode === "mod-enter") {
    const isMac = await page.evaluate(() => navigator.platform.toUpperCase().indexOf("MAC") >= 0)
    if (isMac) {
      await page.keyboard.press("Meta+Enter")
    } else {
      await page.keyboard.press("Control+Enter")
    }
  }
}

async function getLastMessageText(page, provider) {
  const { response } = provider
  const messages = await page.locator(response.messageSelector).all()
  if (messages.length === 0) return ""

  const last = messages[messages.length - 1]

  if (response.textSelector) {
    const innerTexts = await last.locator(response.textSelector).allInnerTexts()
    return innerTexts.join("\n").trim()
  }

  return (await last.innerText()).trim()
}

async function isDone(page, provider, previousTexts) {
  const { response } = provider
  const currentText = await getLastMessageText(page, provider)

  for (const dw of response.doneWhen || []) {
    if (dw.type === "text-stable") {
      const rounds = dw.rounds || response.stableRounds || 3
      const recent = previousTexts.slice(-rounds)
      if (recent.length >= rounds && recent.every((t) => t === currentText) && currentText.length >= (response.minChars || 10)) {
        return { done: true, text: currentText }
      }
    } else if (dw.type === "selector-hidden") {
      if (await checkSelectorHidden(page, dw.selector, 1000)) {
        return { done: true, text: currentText }
      }
    } else if (dw.type === "selector-visible") {
      if (await checkSelectorVisible(page, dw.selector, 1000)) {
        return { done: true, text: currentText }
      }
    } else if (dw.type === "send-enabled") {
      // Check if the send/submit button is enabled => ready for next input
      const { submit } = provider.input
      if (submit.selector) {
        try {
          const isEnabled = await page.locator(submit.selector).first().isEnabled({ timeout: 1000 })
          if (isEnabled && currentText.length >= (response.minChars || 10)) {
            return { done: true, text: currentText }
          }
        } catch {
          // ignore
        }
      }
    }
  }

  return { done: false, text: currentText }
}

async function clickContinueIfPresent(page, provider) {
  if (!provider.continue.enabled || !provider.continue.selector) {
    return false
  }
  try {
    const btn = page.locator(provider.continue.selector).first()
    const count = await btn.count()
    if (count > 0 && (await btn.isVisible())) {
      await btn.click()
      return true
    }
  } catch {
    // ignore
  }
  return false
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
  let continueClicks = 0
  let tracePath = null

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
      throw new LoginRequiredError(
        `Provider "${providerName}" requires login. Please log in at ${provider.auth.loginUrl}`
      )
    }

    // 6. Wait for readyCheck selector
    await page.waitForSelector(provider.auth.readyCheck.selector, {
      state: "visible",
      timeout: 30000,
    })

    // 7. Fill prompt
    await fillInput(page, provider, prompt)

    // 8. Submit
    await submitInput(page, provider)

    // 9-10. Wait for response
    const pollInterval = provider.response.pollIntervalMs || 2000
    const maxWait = Math.min(provider.response.maxWaitMs || 900000, timeoutMs)
    const previousTexts = []

    const deadline = startTime + maxWait

    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw new Error("Aborted")
      }

      await page.waitForTimeout(pollInterval)

      const { done, text } = await isDone(page, provider, previousTexts)
      previousTexts.push(text)
      if (previousTexts.length > 20) {
        previousTexts.shift()
      }

      if (done) {
        resultText = text
        break
      }

      // Handle continue generating if enabled
      if (provider.continue.enabled && continueClicks < (provider.continue.maxClicks || 5)) {
        const clicked = await clickContinueIfPresent(page, provider)
        if (clicked) {
          continueClicks += 1
          await page.waitForTimeout(provider.continue.cooldownMs || 1000)
        }
      }
    }

    if (!resultText) {
      resultText = await getLastMessageText(page, provider)
    }

    // 12. Save context state
    if (trace && tracePath) {
      await context.tracing.stop({ path: tracePath })
    }
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
