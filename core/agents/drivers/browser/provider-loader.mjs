import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { validateProviderProfile, ProviderProfileError } from "./profile-schema.mjs"

const PROVIDERS_DIR = path.join(import.meta.dirname, "providers")

export async function loadProvider(name) {
  if (!name || typeof name !== "string") {
    throw new ProviderProfileError("provider name is required")
  }

  const files = await readdir(PROVIDERS_DIR).catch(() => [])
  const jsonFiles = files.filter((f) => f.endsWith(".json"))

  const candidates = []
  for (const f of jsonFiles) {
    const filePath = path.join(PROVIDERS_DIR, f)
    const raw = await readFile(filePath, "utf8")
    const profile = JSON.parse(raw)

    if (profile.name === name) {
      candidates.push(profile)
      break
    }

    if (profile.aliases && Array.isArray(profile.aliases)) {
      if (profile.aliases.includes(name)) {
        candidates.push(profile)
      }
    }
  }

  if (candidates.length === 0) {
    throw new ProviderProfileError(`provider "${name}" not found in ${PROVIDERS_DIR}`)
  }

  const profile = candidates[0]
  const result = validateProviderProfile(profile)
  if (!result.valid) {
    throw new ProviderProfileError(
      `provider "${name}" profile invalid: ${result.errors.join("; ")}`
    )
  }

  return profile
}

export async function listProviders() {
  const files = await readdir(PROVIDERS_DIR).catch(() => [])
  const jsonFiles = files.filter((f) => f.endsWith(".json"))

  const providers = []
  for (const f of jsonFiles) {
    const filePath = path.join(PROVIDERS_DIR, f)
    try {
      const raw = await readFile(filePath, "utf8")
      const profile = JSON.parse(raw)
      if (profile.name && profile.support) {
        providers.push({
          name: profile.name,
          displayName: profile.displayName || profile.name,
          support: profile.support,
        })
      }
    } catch {
      // Skip invalid files
    }
  }

  return providers
}
