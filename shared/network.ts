export function isLoopbackHost(host: string) {
  const normalized = String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = normalized.split(".");
  return octets.length === 4
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    && Number(octets[0]) === 127;
}

export function normalizeBearerToken(value: unknown, label = "bearer token") {
  const token = String(value || "").trim();
  if (!token) return "";
  if (/\s/.test(token) || Buffer.byteLength(token, "utf8") < 32) {
    throw new Error(`${label} must contain at least 32 non-whitespace bytes`);
  }
  return token;
}

export function assertExplicitInsecureHttpOptIn(
  host: string,
  value: unknown,
  envName: string,
  service: string,
) {
  if (isLoopbackHost(host)) return;
  if (value === true || String(value || "").trim() === "1") return;
  throw new Error(
    `${service} refuses cleartext HTTP on non-loopback hosts; `
    + `bind to loopback behind a TLS reverse proxy or set ${envName}=1 only for an explicitly secured network`,
  );
}
