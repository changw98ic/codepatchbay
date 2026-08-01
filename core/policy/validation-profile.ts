import { recordValue, type LooseRecord } from "../contracts/types.js";

export const VALIDATION_PROFILES = ["smoke", "standard", "verified"] as const;
export type ValidationProfile = (typeof VALIDATION_PROFILES)[number];

export function isValidationProfile(value: unknown): value is ValidationProfile {
  return typeof value === "string" && (VALIDATION_PROFILES as readonly string[]).includes(value);
}

/**
 * The project configuration is the source of truth. SWE-bench tasks without
 * an explicit profile remain verified, so they never silently lose their
 * independent release check during configuration migration.
 */
export function resolveValidationProfile(sourceContext: unknown): ValidationProfile {
  const context = recordValue(sourceContext);
  const productValidation = recordValue(context.productValidation);
  const configured = productValidation.validationProfile ?? context.validationProfile;
  if (isValidationProfile(configured)) return configured;
  return productValidation.validationMode === "swe-bench-verified"
    ? "verified"
    : "standard";
}

export function validationProfileFromProjectConfig(projectConfig: LooseRecord): ValidationProfile {
  const configured = projectConfig.validationProfile;
  if (configured === undefined) return "verified";
  if (!isValidationProfile(configured)) {
    throw new Error("validationProfile must be one of: smoke, standard, verified");
  }
  return configured;
}

export function validationProfilePolicy(profile: ValidationProfile) {
  return {
    profile,
    fusedPlanning: profile !== "verified",
    adversarialRequired: profile === "verified",
    verificationDepth: profile === "verified" ? "strict" : profile === "smoke" ? "smoke" : "standard",
  };
}
