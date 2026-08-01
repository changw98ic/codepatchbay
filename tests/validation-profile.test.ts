import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveValidationProfile,
  validationProfileFromProjectConfig,
  validationProfilePolicy,
} from "../core/policy/validation-profile.js";
import { buildVerifyPrompt } from "../core/phases/verify.js";

test("project validationProfile is explicit, validated, and propagated to task policy", () => {
  assert.equal(validationProfileFromProjectConfig({ validationProfile: "standard" }), "standard");
  assert.equal(validationProfileFromProjectConfig({}), "verified");
  assert.throws(
    () => validationProfileFromProjectConfig({ validationProfile: "fast" }),
    /validationProfile must be one of/i,
  );
  assert.equal(resolveValidationProfile({ productValidation: { validationProfile: "smoke" } }), "smoke");
  assert.equal(validationProfilePolicy("smoke").verificationDepth, "smoke");
  assert.equal(validationProfilePolicy("smoke").adversarialRequired, false);
  assert.equal(validationProfilePolicy("verified").adversarialRequired, true);
});

test("verify prompt gives smoke and standard profiles different verification instructions", async () => {
  const base = {
    cpbRoot: "/tmp/cpb-validation-profile",
    project: "flow",
    jobId: "job-validation-profile",
    task: "Update the target behavior.",
    previousResults: [],
  };
  const smoke = await buildVerifyPrompt({
    ...base,
    sourceContext: { productValidation: { validationProfile: "smoke" } },
  }, null, {});
  const standard = await buildVerifyPrompt({
    ...base,
    sourceContext: { productValidation: { validationProfile: "standard" } },
  }, null, {});

  assert.match(smoke, /Validation profile: smoke/);
  assert.match(smoke, /smallest repository-native check/i);
  assert.match(standard, /Validation profile: standard/);
  assert.match(standard, /relevant regression path/i);
});
