export async function fillPrompt(page, provider, prompt) {
  const { input } = provider
  const el = page.locator(input.selector).first()

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
        const element = document.querySelector(sel)
        if (!element) return
        if (element.tagName === "TEXTAREA" || element.tagName === "INPUT") {
          element.value = text
        } else if (element.isContentEditable) {
          element.textContent = text
        }
        element.dispatchEvent(new Event("input", { bubbles: true }))
        element.dispatchEvent(new Event("change", { bubbles: true }))
      },
      input.selector,
      prompt
    )
  }
}

export async function submitPrompt(page, provider) {
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
