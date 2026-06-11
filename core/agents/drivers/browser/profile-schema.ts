// @ts-nocheck
export const PROFILE_SCHEMA = {
  schemaVersion: 1,
  name: "string (required)",
  displayName: "string (required)",
  aliases: "string[] (optional)",
  support: {
    tier: "official|best-effort|experimental",
    requiresManualLogin: "boolean",
    lastVerified: "string|null",
  },
  startUrl: "string (required)",
  auth: {
    type: "persistent-profile",
    loginUrl: "string (required)",
    loginCheck: {
      mode: "selector-visible",
      selector: "string (required)",
    },
    readyCheck: {
      mode: "selector-visible",
      selector: "string (required)",
    },
  },
  input: {
    selector: "string (required)",
    kind: "textarea|contenteditable|selector",
    method: "fill|type|paste",
    clearBeforeInput: "boolean",
    submit: {
      mode: "button|enter|mod-enter",
      selector: "string|null",
    },
  },
  response: {
    messageSelector: "string (required)",
    textSelector: "string|null",
    mode: "last-message",
    stableRounds: "number (default 3)",
    minChars: "number (default 10)",
    pollIntervalMs: "number (default 2000)",
    maxWaitMs: "number (default 900000)",
    doneWhen: [
      { type: "text-stable", rounds: 3 },
      { type: "selector-hidden", selector: "..." },
      { type: "selector-visible", selector: "..." },
      { type: "send-enabled" },
    ],
  },
  continue: {
    enabled: "boolean",
    selector: "string|null",
    maxClicks: "number (default 5)",
    cooldownMs: "number (default 1000)",
  },
  diagnostics: {
    screenshotOnFailure: "boolean (default true)",
    traceOnFailure: "boolean (default false)",
  },
}

export class LoginRequiredError extends Error {
  constructor(message) {
    super(message)
    this.name = "LoginRequiredError"
    this.code = "LOGIN_REQUIRED"
  }
}

export class ProviderProfileError extends Error {
  constructor(message) {
    super(message)
    this.name = "ProviderProfileError"
    this.code = "PROFILE_INVALID"
  }
}

function assertString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    return `${field} must be a non-empty string`
  }
  return null
}

function assertBoolean(value, field) {
  if (typeof value !== "boolean") {
    return `${field} must be a boolean`
  }
  return null
}

function assertNumber(value, field, opts = {}) {
  const { min, max, default: defaultValue } = opts
  if (value === undefined && defaultValue !== undefined) return null
  if (typeof value !== "number" || Number.isNaN(value)) {
    return `${field} must be a number`
  }
  if (min !== undefined && value < min) return `${field} must be >= ${min}`
  if (max !== undefined && value > max) return `${field} must be <= ${max}`
  return null
}

function assertArray(value, field, itemValidator) {
  if (value === undefined) return null
  if (!Array.isArray(value)) {
    return `${field} must be an array`
  }
  for (let i = 0; i < value.length; i += 1) {
    const err = itemValidator(value[i], `${field}[${i}]`)
    if (err) return err
  }
  return null
}

export function validateProviderProfile(profile) {
  const errors = []

  if (!profile || typeof profile !== "object") {
    return { valid: false, errors: ["profile must be an object"] }
  }

  const e = (msg) => errors.push(msg)

  const nameErr = assertString(profile.name, "name")
  if (nameErr) e(nameErr)

  const displayNameErr = assertString(profile.displayName, "displayName")
  if (displayNameErr) e(displayNameErr)

  const aliasesErr = assertArray(profile.aliases, "aliases", (v, f) =>
    assertString(v, f)
  )
  if (aliasesErr) e(aliasesErr)

  if (profile.support && typeof profile.support === "object") {
    const validTiers = ["official", "best-effort", "experimental"]
    if (!validTiers.includes(profile.support.tier)) {
      e(`support.tier must be one of ${validTiers.join(", ")}`)
    }
    const manualErr = assertBoolean(
      profile.support.requiresManualLogin,
      "support.requiresManualLogin"
    )
    if (manualErr) e(manualErr)
  } else {
    e("support object is required")
  }

  const startUrlErr = assertString(profile.startUrl, "startUrl")
  if (startUrlErr) e(startUrlErr)

  if (profile.auth && typeof profile.auth === "object") {
    const loginUrlErr = assertString(profile.auth.loginUrl, "auth.loginUrl")
    if (loginUrlErr) e(loginUrlErr)

    if (profile.auth.loginCheck && typeof profile.auth.loginCheck === "object") {
      const lcErr = assertString(profile.auth.loginCheck.selector, "auth.loginCheck.selector")
      if (lcErr) e(lcErr)
    } else {
      e("auth.loginCheck object is required")
    }

    if (profile.auth.readyCheck && typeof profile.auth.readyCheck === "object") {
      const rcErr = assertString(profile.auth.readyCheck.selector, "auth.readyCheck.selector")
      if (rcErr) e(rcErr)
    } else {
      e("auth.readyCheck object is required")
    }
  } else {
    e("auth object is required")
  }

  if (profile.input && typeof profile.input === "object") {
    const selectorErr = assertString(profile.input.selector, "input.selector")
    if (selectorErr) e(selectorErr)

    const validKinds = ["textarea", "contenteditable", "selector"]
    if (!validKinds.includes(profile.input.kind)) {
      e(`input.kind must be one of ${validKinds.join(", ")}`)
    }

    const validMethods = ["fill", "type", "paste"]
    if (!validMethods.includes(profile.input.method)) {
      e(`input.method must be one of ${validMethods.join(", ")}`)
    }

    const clearErr = assertBoolean(profile.input.clearBeforeInput, "input.clearBeforeInput")
    if (clearErr) e(clearErr)

    if (profile.input.submit && typeof profile.input.submit === "object") {
      const validModes = ["button", "enter", "mod-enter"]
      if (!validModes.includes(profile.input.submit.mode)) {
        e(`input.submit.mode must be one of ${validModes.join(", ")}`)
      }
    } else {
      e("input.submit object is required")
    }
  } else {
    e("input object is required")
  }

  if (profile.response && typeof profile.response === "object") {
    const msErr = assertString(profile.response.messageSelector, "response.messageSelector")
    if (msErr) e(msErr)

    const roundsErr = assertNumber(profile.response.stableRounds, "response.stableRounds", {
      min: 1,
      default: 3,
    })
    if (roundsErr) e(roundsErr)

    const minCharsErr = assertNumber(profile.response.minChars, "response.minChars", {
      min: 0,
      default: 10,
    })
    if (minCharsErr) e(minCharsErr)

    const pollErr = assertNumber(profile.response.pollIntervalMs, "response.pollIntervalMs", {
      min: 100,
      default: 2000,
    })
    if (pollErr) e(pollErr)

    const maxWaitErr = assertNumber(profile.response.maxWaitMs, "response.maxWaitMs", {
      min: 1000,
      default: 900000,
    })
    if (maxWaitErr) e(maxWaitErr)

    if (profile.response.doneWhen && Array.isArray(profile.response.doneWhen)) {
      const validTypes = ["text-stable", "selector-hidden", "selector-visible", "send-enabled"]
      for (let i = 0; i < profile.response.doneWhen.length; i += 1) {
        const dw = profile.response.doneWhen[i]
        if (!dw || typeof dw !== "object") {
          e(`response.doneWhen[${i}] must be an object`)
          continue
        }
        if (!validTypes.includes(dw.type)) {
          e(`response.doneWhen[${i}].type must be one of ${validTypes.join(", ")}`)
        }
        if (
          (dw.type === "selector-hidden" || dw.type === "selector-visible") &&
          typeof dw.selector !== "string"
        ) {
          e(`response.doneWhen[${i}].selector is required for type ${dw.type}`)
        }
      }
    }
  } else {
    e("response object is required")
  }

  if (profile.continue && typeof profile.continue === "object") {
    const enabledErr = assertBoolean(profile.continue.enabled, "continue.enabled")
    if (enabledErr) e(enabledErr)

    const maxClicksErr = assertNumber(profile.continue.maxClicks, "continue.maxClicks", {
      min: 0,
      default: 5,
    })
    if (maxClicksErr) e(maxClicksErr)

    const cooldownErr = assertNumber(profile.continue.cooldownMs, "continue.cooldownMs", {
      min: 0,
      default: 1000,
    })
    if (cooldownErr) e(cooldownErr)
  } else {
    e("continue object is required")
  }

  if (profile.diagnostics && typeof profile.diagnostics === "object") {
    const ssErr = assertBoolean(
      profile.diagnostics.screenshotOnFailure,
      "diagnostics.screenshotOnFailure"
    )
    if (ssErr) e(ssErr)

    const trErr = assertBoolean(
      profile.diagnostics.traceOnFailure,
      "diagnostics.traceOnFailure"
    )
    if (trErr) e(trErr)
  } else {
    e("diagnostics object is required")
  }

  if (errors.length > 0) {
    return { valid: false, errors }
  }
  return { valid: true, errors: [] }
}
