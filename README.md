# hereya/aws-ddb-app-state

DynamoDB tables for non-auth application state. Separate from the `aws/cognito` package, which owns user identity (OTP, sessions, users, roles), this package owns the tables the application's *domain* writes to.

## What it provisions

| Resource | Purpose |
|---|---|
| `RegistrationsTable` | Public-form submissions. PK = `email`. Schema-less; each project's form decides its own field set. |
| `OAuthStateTable` | OAuth 2.1 / MCP machinery state. PK = `<KIND>#<id>` (`CLIENT`, `CODE`, `TOKEN`, `REFRESH`). DDB native TTL on `ttl` attribute. GSI `byUser-index` (PK userId, SK createdAt) for listing a user's active token connections. |
| `iamPolicyForAppState` | Single inline-policy JSON granting the application Lambda read/write on both tables and their indexes. |

## Outputs (consumed by the Lambda via hereya variable resolution)

| Name | Description |
|---|---|
| `registrationsTableName` | DDB table name for registrations |
| `oauthStateTableName` | DDB table name for OAuth state |
| `iamPolicyForAppState` | JSON-encoded inline IAM policy |

## Why two tables?

`RegistrationsTable` is schema-less and PK-only. Public registrations accrue independently of any user — a non-authenticated form submission lands here, the row persists, an admin can list/delete via `/admin/registrations`. No relationship to identity.

`OAuthStateTable` is single-table-design over the four OAuth entity kinds. Discriminator prefix keeps them in one physical table (cheap, lockstep IAM, fewer CloudFormation resources). Each kind has a distinct access pattern:

- **CLIENT**: DCR registration (`PutItem`) + point lookup by clientId (`GetItem`).
- **CODE**: issuance (`PutItem` with 60s `ttl`) + point lookup (`GetItem`) + delete on consume (`DeleteItem`). DDB TTL is best-effort eventual cleanup; the app filters expired at read.
- **TOKEN**: issuance (`PutItem`) + point lookup by access hash (`GetItem`) + revoke (`UpdateItem` `revokedAt`) + list by user (`Query` on byUser-index). 24h access / 30d refresh expiry → `ttl` set to refresh expiry so DDB sweeps eventually.
- **REFRESH**: pointer item (`PutItem`) → looks up the canonical `TOKEN#` row on refresh-flow. `ttl` mirrors the token's.

## Why a separate package and not in aws-cognito?

Identity vs. application state. Cognito owns "who is this user." This package owns "what data has the user (or the public) generated." Splitting:

- Keeps the cognito package focused on a single concern (and renameable / swappable in the future without touching app data).
- Lets future projects opt into "app state in DDB" without OAuth/MCP; or vice versa.
- Creates a natural home for future patterns (e.g. Stripe customer mapping, feature flags) — extend this package rather than bloating cognito.

## Usage

Add to `hereya.yaml`:

```yaml
packages:
  hereya/aws-ddb-app-state:
    version: 0.1.0
```

The application Lambda's execution role automatically picks up `iamPolicyForAppState`; env vars `registrationsTableName` and `oauthStateTableName` are wired through hereya's standard variable resolution.

## Item shapes

### RegistrationsTable

```json
{
  "email": "user@example.com",
  "createdAt": "2026-05-13T18:00:00Z",
  "<extra fields per the project's form>": "..."
}
```

### OAuthStateTable

```json
{ "pk": "CLIENT#<clientId>",
  "clientId": "...", "name": "...", "redirectUris": [...], "createdAt": "..." }

{ "pk": "CODE#<authCode>",
  "clientId": "...", "userId": "...", "redirectUri": "...",
  "codeChallenge": "...", "codeChallengeMethod": "S256",
  "scope": "...", "expiresAt": <unix-seconds>, "ttl": <expiresAt> }

{ "pk": "TOKEN#<accessTokenHash>",
  "accessTokenHash": "...", "refreshTokenHash": "...",
  "clientId": "...", "userId": "...", "scope": "...",
  "accessExpiresAt": <unix>, "refreshExpiresAt": <unix>,
  "revokedAt": null | <iso>,
  "createdAt": "<iso>",
  "ttl": <refreshExpiresAt> }

{ "pk": "REFRESH#<refreshTokenHash>",
  "accessTokenHash": "...",
  "ttl": <refreshExpiresAt> }
```
