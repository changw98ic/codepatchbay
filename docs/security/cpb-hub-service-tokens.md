# Hub service-token authorization

The Hub supports named, scoped service tokens for deployments that must not
share one global bearer secret. This is a service-account foundation, not an
interactive human-session implementation. Enterprise JWT access-token
validation is documented separately in [Hub OIDC authorization](cpb-hub-oidc.md).

## Compatibility and defaults

- With no credentials configured, a loopback-only Hub keeps the existing local
  anonymous administrator behavior.
- `CPB_HUB_BEARER_TOKEN` remains supported as the `legacy-admin` principal with
  global `hub:admin` access.
- `CPB_HUB_SERVICE_TOKENS_FILE` enables named service principals. It must be an
  absolute path to a regular, non-symlink file. On POSIX, group and other
  permission bits must be zero (for example, mode `0600`). Store it outside the
  Hub root so credential digests are not copied into Hub backups.
- A non-loopback Hub requires at least one configured credential and still
  requires the existing explicit cleartext-network opt-in when TLS terminates
  elsewhere.
- The Hub fingerprints the configured file on every request and atomically
  reloads a changed file. Rotation, revocation, scope, project, and expiry
  changes therefore take effect without restarting the Hub.

## File format

Store only SHA-256 digests in the file. Source bearer tokens must still be
cryptographically random and contain at least 32 non-whitespace bytes; hashing
does not make a weak token strong.

```json
{
  "format": "cpb-hub-service-tokens/v1",
  "tokens": [
    {
      "id": "ci-alpha-reader",
      "tokenSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "scopes": ["hub:read"],
      "projects": ["alpha"],
      "expiresAt": "2027-01-01T00:00:00.000Z"
    },
    {
      "id": "platform-admin",
      "tokenSha256": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      "scopes": ["hub:admin"],
      "projects": "*"
    }
  ]
}
```

Generate a high-entropy token and its digest without placing the token directly
in the JSON file:

```sh
umask 077
TOKEN="$(openssl rand -hex 32)"
printf '%s\n' "$TOKEN" > /secure/cpb/ci-alpha-reader.token
printf '%s' "$TOKEN" | shasum -a 256
unset TOKEN
chmod 600 /secure/cpb/ci-alpha-reader.token /secure/cpb/hub-service-tokens.json
export CPB_HUB_SERVICE_TOKENS_FILE=/secure/cpb/hub-service-tokens.json
```

The token file rejects unknown fields, duplicate principal ids, duplicate token
digests, unsupported scopes, malformed project ids, unsafe permissions,
symlinks, oversized content, concurrent modification while reading, and a
configuration in which every credential is expired. Plaintext `token` fields
are rejected.

## Rotation and revocation

Build a complete replacement file with private permissions, then atomically
rename it over the configured path. Do not truncate and rewrite the live file:
a request that observes a partial write will correctly fail closed.

```sh
umask 077
cp /secure/cpb/hub-service-tokens.json /secure/cpb/hub-service-tokens.json.next
# Edit the complete .next file, remove revoked digests, and add replacement digests.
chmod 600 /secure/cpb/hub-service-tokens.json.next
mv /secure/cpb/hub-service-tokens.json.next /secure/cpb/hub-service-tokens.json
```

The first request after the rename loads the replacement; concurrent requests
share the same reload. Once it succeeds, removed tokens receive `401` and new
tokens use their declared authorization immediately. The legacy environment
token remains static and still requires a process restart to change.

If the configured service-token file is missing, malformed, unsafe, expired in
full, or changes while being read, requests receive HTTP `503` with
`Retry-After: 5` and code `HUB_AUTH_CONFIGURATION_UNAVAILABLE`. The Hub does not
fall back to its previous snapshot or to the legacy token while a configured
file is invalid. Repairing or atomically replacing the file restores service on
the next request without a restart.

## Scopes and project boundaries

| Scope | Allows |
| --- | --- |
| `hub:health` | `GET /api/health` and authenticated identity inspection |
| `hub:read` | `hub:health` plus `GET /api/projects` |
| `hub:admin` | All Hub scopes; must use `projects: "*"` |

`projects` must be `"*"` or a non-empty array. Project-scoped readers receive
only authorized projects from collection endpoints. An empty filtered result is
returned as `[]` so unauthorized project names are not disclosed.

`GET /api/auth/whoami` returns the authenticated `id`, declared `scopes`,
project boundary, credential source, and optional expiry. Authenticated
responses also include `X-CPB-Principal-Id` for reverse-proxy access logs.

## Error contract

Authentication failure remains HTTP `401` with the compatibility field
`"error": "unauthorized"`, and adds:

```json
{
  "error": "unauthorized",
  "code": "HUB_AUTHENTICATION_REQUIRED",
  "message": "A valid Hub bearer token is required"
}
```

When no credential is presented, the response includes
`WWW-Authenticate: Bearer realm="CodePatchBay Hub"`. An invalid presented token
adds `error="invalid_token"` to the same Bearer challenge.

An authenticated principal without the required scope receives HTTP `403`:

```json
{
  "error": "forbidden",
  "code": "HUB_SCOPE_REQUIRED",
  "message": "Hub scope 'hub:read' is required",
  "requiredScope": "hub:read"
}
```

Do not translate `401` and `403` into one status at a reverse proxy: clients use
the distinction to separate invalid credentials from insufficient permission.
The `403` response includes an `insufficient_scope` Bearer challenge with the
required Hub scope.

An unavailable configured credential file fails closed with HTTP `503`:

```json
{
  "error": "service_unavailable",
  "code": "HUB_AUTH_CONFIGURATION_UNAVAILABLE",
  "message": "Hub authentication configuration is unavailable",
  "requestId": "<request-id>"
}
```

The response includes `Retry-After: 5`; its request id is also recorded in the
durable Hub access audit.
