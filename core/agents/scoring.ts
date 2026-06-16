function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function ratio(numerator: number, denominator: number, fallback: number = 0): number {
  const n = Number(numerator) || 0;
  const d = Number(denominator) || 0;
  if (d <= 0) return fallback;
  return clamp01(n / d);
}

function durationScore(totalDurationMs: number, sampleSize: number): number {
  const total = Number(totalDurationMs) || 0;
  const samples = Number(sampleSize) || 0;
  if (total <= 0 || samples <= 0) return 0.5;
  const avg = total / samples;
  return clamp01(1 / (1 + (avg / 600_000)));
}

export function scoreAgentMetrics(input: Record<string, any> = {}) {
  const totalJobs = Math.max(0, Number(input.totalJobs) || 0);
  const successes = Math.max(0, Number(input.successes) || 0);
  const retries = Math.max(0, Number(input.retries) || 0);
  const verifierRuns = Math.max(0, Number(input.verifierRuns) || 0);
  const verifierPasses = Math.max(0, Number(input.verifierPasses) || 0);
  const timeouts = Math.max(0, Number(input.timeouts) || 0);
  const userRejections = Math.max(0, Number(input.userRejections) || 0);
  const sampleSize = totalJobs;

  if (sampleSize === 0) {
    return {
      value: 0.5,
      confidence: 0.1,
      sampleSize: 0,
      components: {
        successRate: 0.5,
        durationScore: 0.5,
        retryRate: 0,
        verifierPassRate: 0.5,
        timeoutRate: 0,
        userRejectionRate: 0,
      },
    };
  }

  const components = {
    successRate: ratio(successes, totalJobs),
    durationScore: durationScore(input.totalDurationMs, totalJobs),
    retryRate: ratio(retries, totalJobs),
    verifierPassRate: ratio(verifierPasses, verifierRuns, 0.5),
    timeoutRate: ratio(timeouts, totalJobs),
    userRejectionRate: ratio(userRejections, totalJobs),
  };

  const value = clamp01(
    components.successRate * 0.35
    + components.verifierPassRate * 0.25
    + components.durationScore * 0.15
    + (1 - components.retryRate) * 0.1
    + (1 - components.timeoutRate) * 0.1
    + (1 - components.userRejectionRate) * 0.05,
  );

  return {
    value,
    confidence: clamp01(sampleSize / 20),
    sampleSize,
    components,
  };
}
