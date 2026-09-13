# aws-ddb-app-state — agent notes

Package scope: non-auth application-state DynamoDB tables. Stays out of `aws/cognito`'s lane (identity infrastructure).

## What's here

Two CDK tables in `lib/app-state-stack.ts`:

- `RegistrationsTable` (PK email) — public-form data
- `OAuthStateTable` (PK pk = "KIND#id", TTL on `ttl`, GSI `byUser-index`) — OAuth/MCP state

Outputs (consumed by Lambda env via hereya variable resolution): `registrationsTableName`, `oauthStateTableName`, `iamPolicyForAppState`.

## When to extend this package

Future patterns that need a small purpose-specific DDB table (Stripe customer mapping, feature flags, audit log) belong here — add a table to `app-state-stack.ts`, extend the IAM policy resource list, add a CfnOutput for the table name. Bump `hereyarc.yml` version.

Don't extend it for:

- **Identity / auth** — goes in `aws/cognito` (sessions, users, roles, OTP).
- **Relational app data** (notes, full app state with joins) — use `aws-postgres-serverless`. The "notes" pattern in the template docs walks through that path.
- **Files / blobs** — use `aws-file-storage`.

## Versioning

`0.1.0` is the initial cut. Additive table additions = minor bump. Removing or renaming a table = major (would break existing projects that pin the version).

`0.1.1` hardens both tables in place: point-in-time recovery, deletion protection, `RemovalPolicy.RETAIN` (the `DURABLE` spread in `app-state-stack.ts`). Keep it on every table added here — this package exists for state a project cannot regenerate.

## Why no separate IAM policies per table

aws-cognito ships one inline policy covering all its tables to stay under the 2KB inline-policy ceiling on hereya/dev-iam-user. This package follows the same convention — one `iamPolicyForAppState` output, single union of all actions. Splitting per table is fine if the policy ever grows past 2KB.
