export class BrowserAgentLoginRequiredError extends Error {
  code: string
  provider: string
  kind: string
  retryable: boolean

  constructor(provider: string, message?: string) {
    super(message || `${provider} requires login`)
    this.name = "BrowserAgentLoginRequiredError"
    this.code = "LOGIN_REQUIRED"
    this.provider = provider
    this.kind = "agent_unavailable"
    this.retryable = false
  }
}

export class BrowserAgentCaptchaRequiredError extends Error {
  code: string
  provider: string
  kind: string
  retryable: boolean

  constructor(provider: string, message?: string) {
    super(message || `${provider} requires CAPTCHA`)
    this.name = "BrowserAgentCaptchaRequiredError"
    this.code = "CAPTCHA_REQUIRED"
    this.provider = provider
    this.kind = "agent_unavailable"
    this.retryable = false
  }
}

export class BrowserAgentRateLimitedError extends Error {
  code: string
  provider: string
  kind: string
  retryable: boolean

  constructor(provider: string, message?: string) {
    super(message || `${provider} rate limited`)
    this.name = "BrowserAgentRateLimitedError"
    this.code = "RATE_LIMITED"
    this.provider = provider
    this.kind = "agent_rate_limited"
    this.retryable = true
  }
}

export class BrowserAgentSelectorError extends Error {
  code: string
  selector: string
  kind: string
  retryable: boolean

  constructor(selector: string, message?: string) {
    super(message || `Selector not found: ${selector}`)
    this.name = "BrowserAgentSelectorError"
    this.code = "SELECTOR_ERROR"
    this.selector = selector
    this.kind = "agent_contract_invalid"
    this.retryable = false
  }
}

export class BrowserAgentTimeoutError extends Error {
  code: string
  timeoutMs: number
  kind: string
  retryable: boolean

  constructor(timeoutMs: number, message?: string) {
    super(message || `Timed out after ${timeoutMs}ms`)
    this.name = "BrowserAgentTimeoutError"
    this.code = "TIMEOUT"
    this.timeoutMs = timeoutMs
    this.kind = "timeout"
    this.retryable = true
  }
}

export class BrowserAgentOutputEmptyError extends Error {
  code: string
  provider: string
  kind: string
  retryable: boolean

  constructor(provider: string, message?: string) {
    super(message || `${provider} returned empty output`)
    this.name = "BrowserAgentOutputEmptyError"
    this.code = "OUTPUT_EMPTY"
    this.provider = provider
    this.kind = "agent_contract_invalid"
    this.retryable = true
  }
}
