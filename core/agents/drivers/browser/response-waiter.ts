// @ts-nocheck
import { BrowserAgentTimeoutError } from "./errors.js"

export async function checkSelectorVisible(page, selector, timeoutMs = 5000) {
  try {
    await page.waitForSelector(selector, { state: "visible", timeout: timeoutMs })
    return true
  } catch {
    return false
  }
}

export async function checkSelectorHidden(page, selector, timeoutMs = 5000) {
  try {
    await page.waitForSelector(selector, { state: "hidden", timeout: timeoutMs })
    return true
  } catch {
    return false
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

export async function waitForFinalResponse(page, provider, options = {}) {
  const { signal, timeoutMs = 900_000 } = options
  const pollInterval = provider.response.pollIntervalMs || 2000
  const maxWait = Math.min(provider.response.maxWaitMs || 900_000, timeoutMs)
  const previousTexts = []
  const startTime = Date.now()
  const deadline = startTime + maxWait
  let resultText = ""
  let continueClicks = 0

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

    if (provider.continue.enabled && continueClicks < (provider.continue.maxClicks || 5)) {
      const clicked = await clickContinueIfPresent(page, provider)
      if (clicked) {
        continueClicks += 1
        await page.waitForTimeout(provider.continue.cooldownMs || 1000)
      }
    }
  }

  if (!resultText) {
    throw new BrowserAgentTimeoutError(maxWait, `Response did not stabilize within ${maxWait}ms`)
  }

  const elapsedMs = Date.now() - startTime
  const stableRounds = provider.response.stableRounds || 3

  return {
    text: resultText,
    elapsedMs,
    stableRounds,
    continueClicks,
  }
}
