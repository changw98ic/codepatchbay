# Hub OIDC JWT access-token authorization

CodePatchBay Hub can act as an OAuth resource server for enterprise identity
providers that issue RFC 9068 JWT access tokens. This is API bearer-token
validation: it is not an interactive browser login, an OIDC ID-token consumer,
SAML, SCIM, or an opaque-token introspection client.

The implementation follows the separation required by RFC 8725: an OIDC ID
token or another JWT type is never accepted by the access-token validator.

## Configuration

Set `CPB_HUB_OIDC_CONFIG_FILE` to an absolute path outside the Hub root. The
file must be a real, non-symlink file and, on POSIX, must not be readable or
writable by group or other users (for example, mode `0600`).

```json
{
  "format": "cpb-hub-oidc/v1",
  "profile": "rfc9068",
  "issuer": "https://identity.example.com/tenant",
  "audiences": ["urn:codepatchbay:hub"],
  "jwksUri": "https://identity.example.com/tenant/keys",
  "algorithms": ["RS256"],
  "groupsClaim": "groups",
  "groupMappings": {
    "cpb-platform-admins": {
      "scopes": ["hub:admin"],
      "projects": "*"
    },
    "cpb-alpha-readers": {
      "scopes": ["hub:read"],
      "projects": ["alpha"]
    },
    "cpb-health-monitors": {
      "scopes": ["hub:health"],
      "projects": ["alpha"]
    }
  },
  "clockSkewSeconds": 60,
  "maxTokenAgeSeconds": 3600,
  "jwksCacheSeconds": 300,
  "jwksRefreshMinSeconds": 30,
  "requestTimeoutMs": 5000
}
```

Only `RS256` and `ES256` are supported. The allowlist is explicit and the
token's `alg` never selects an otherwise disabled algorithm. The issuer and
JWKS URL must use HTTPS; issuer comparison is exact. A pinned `jwksUri` avoids
using unverified token claims for discovery or following attacker-controlled
`jku`, `x5u`, or embedded keys.

The file contains authorization policy rather than a client secret. Hub does
not need an OAuth client secret to validate a signed access token. Protect the
file anyway: anyone who can change a group mapping can change Hub privileges.

## Required token profile

The bearer token must be a compact, signed RFC 9068 access token:

- `typ` is `at+jwt` or `application/at+jwt`;
- `alg` is enabled by the local policy and matches the selected public key;
- `iss`, `aud`, `sub`, `client_id`, `iat`, `exp`, and `jti` are present and
  valid;
- `nbf`, when present, is enforced with the bounded clock-skew allowance;
- the lifetime does not exceed `maxTokenAgeSeconds`;
- the signature verifies against a permitted public signing key.

Ordinary OIDC ID tokens normally use `typ: JWT` and a client audience. They are
rejected even if their signature is valid. Opaque OAuth access tokens are also
rejected because Hub does not currently implement introspection.

`(issuer, subject)` is hashed into a stable `oidc:<hash>` principal id. Raw
subjects, groups, claims, access tokens, and JWKS bodies are not written to the
Hub access audit or returned by `GET /api/auth/whoami`.

## Authorization mapping

JWT verification proves token authenticity, not Hub authorization. Hub grants
permissions only through exact local `groupMappings` entries:

- a subject with no mapped group is authenticated but has no scopes or project
  access, so protected operations return `403`;
- matching mappings are combined, scopes use the fixed Hub scope hierarchy,
  and project ids are unioned;
- any mapping granting `hub:admin` must use `projects: "*"`;
- token `scope`, email, display name, and arbitrary role strings are not
  automatically trusted as Hub permissions.

Replace the complete policy file with an atomic rename to change mappings.
Concurrent requests share one reload. Invalid, missing, unsafe, or partially
written replacement files fail closed until repaired; the previous policy is
not silently retained for requests.

## JWKS cache and key rotation

Hub loads only public RSA or P-256 signing keys. It rejects private or symmetric
key material, duplicate key ids, weak RSA keys, incompatible `alg`, `use`, or
`key_ops`, redirects, unsupported content types, oversized bodies, and invalid
JSON. A token and JWKS may omit `kid` only when exactly one compatible signing
key exists; ambiguous key sets are rejected. Fetches have a bounded timeout and
response-size limit.

JWKS snapshots are replaced only after the complete candidate validates.
Concurrent fetches use one in-flight request. HTTP `max-age`, `no-cache`, and
`no-store` can shorten the configured cache duration but cannot extend it;
intermediary `Age` is subtracted from an advertised `max-age`.
ETag and Last-Modified validators are sent on refresh.

An unknown `kid` can trigger one early refresh, subject to
`jwksRefreshMinSeconds`, which prevents random-key-id traffic from turning into
unbounded identity-provider requests. A fresh cached known key remains usable
during a temporary IdP outage. Once the cache expires, refresh failure returns
`503`; Hub never uses an indefinitely stale key set.

For planned rotation, publish the new key before issuing tokens signed with it,
and retain the previous key for at least the maximum token lifetime, clock skew,
and cache propagation interval. Self-contained bearer JWTs cannot provide
instant token revocation. Emergency revocation requires short lifetimes,
removing the signing key, or a future online introspection/denylist mechanism.

## HTTP and operational contract

| Condition | Response |
| --- | --- |
| Missing, malformed, expired, substituted, or invalid token | `401 HUB_AUTHENTICATION_REQUIRED` |
| Valid identity without the required mapped scope | `403 HUB_SCOPE_REQUIRED` |
| OIDC policy file unavailable or invalid | `503 HUB_OIDC_CONFIGURATION_UNAVAILABLE` |
| No fresh JWKS and the IdP cannot be reached or validated | `503 HUB_IDENTITY_PROVIDER_UNAVAILABLE` |

An invalid presented token receives a Bearer challenge with
`error="invalid_token"`. A mapped identity lacking the required scope receives
`error="insufficient_scope"` and the required Hub scope. A request with no
credentials keeps the compatibility `Bearer realm="CodePatchBay Hub"`
challenge.

The `503` responses include `Retry-After: 5` and a request id. External errors
do not reveal whether a key id, signature, issuer, audience, or upstream
response caused validation to fail. The durable access audit records the
stable machine code and the hashed principal id when authentication succeeded.

Run `cpb doctor` with the same auth-related environment as the Hub process.
Doctor validates local policy and performs a bounded JWKS preflight, reporting
only authentication modes, public-key count, and cache freshness. It does not
prove that an already-running daemon has the same environment.

Terminate TLS at a trusted reverse proxy unless Hub is strictly loopback-only.
Cleartext non-loopback HTTP continues to require the explicit existing network
opt-in and should be limited to an independently protected network.

## Standards

- [RFC 9068: JWT Profile for OAuth 2.0 Access Tokens](https://www.rfc-editor.org/rfc/rfc9068.html)
- [RFC 8725: JSON Web Token Best Current Practices](https://www.rfc-editor.org/rfc/rfc8725.html)
- [RFC 7515: JSON Web Signature](https://www.rfc-editor.org/rfc/rfc7515.html)
- [RFC 7517: JSON Web Key](https://www.rfc-editor.org/rfc/rfc7517.html)
- [RFC 7519: JSON Web Token](https://www.rfc-editor.org/rfc/rfc7519.html)
- [RFC 6750: OAuth 2.0 Bearer Token Usage](https://www.rfc-editor.org/rfc/rfc6750.html)
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)
