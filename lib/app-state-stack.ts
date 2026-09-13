import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

/**
 * Application-state DynamoDB tables, separated from identity infrastructure.
 *
 * The companion `aws/cognito` package owns user identity tables (OTP,
 * sessions, auth users, auth roles). This package owns the tables the
 * application's *domain* writes to — currently:
 *
 *   • RegistrationsTable — public-form submissions (newsletter signups,
 *                          webinar registrations, etc.). Schema-less; each
 *                          project's form decides its own field set on top
 *                          of the email partition key.
 *
 *   • OAuthStateTable   — OAuth 2.1 / MCP machinery state: DCR clients,
 *                          auth codes, access + refresh tokens. Single-
 *                          table design with PK = `<KIND>#<id>` (CLIENT,
 *                          CODE, TOKEN, REFRESH). Items carry a `ttl`
 *                          attribute so DDB auto-prunes expired rows.
 *                          A byUser-index GSI supports listing a user's
 *                          active token connections.
 *
 * Lambda env is wired through hereya variable resolution:
 *
 *   registrationsTableName  → DDB table name
 *   oauthStateTableName     → DDB table name
 *   iamPolicyForAppState    → JSON-encoded inline policy bundled to the
 *                             execution role (DDB read/write on both
 *                             tables + their indexes).
 *
 * The IAM policy is emitted as a single JSON-encoded output so it stays
 * under IAM's 2KB inline-policy ceiling when attached to a hereya/dev-iam-
 * user — same convention used by aws-cognito's `iamPolicyForCognito`.
 */
export class AwsDdbAppStateStack extends cdk.Stack {
  public readonly registrationsTable: dynamodb.Table;
  public readonly oauthStateTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- Durable posture, both tables (0.1.1) -------------------------------
    //
    // These tables hold what a project cannot regenerate: registrations,
    // and — in single-table OAuth/MCP state — whatever domain rows a project
    // keys alongside (organizations, negotiated offers, integration
    // credentials). Until 0.1.1 they shipped with `removalPolicy: DESTROY`,
    // no point-in-time recovery and no deletion protection: a stack
    // deletion, a bad migration or a logical corruption erased them with no
    // way back. Found on a production table holding ~12 000 items.
    //
    //   • PITR — continuous backups, restore to any second in the last 35 days.
    //   • deletionProtection — the table refuses DeleteTable, from CFN or CLI.
    //   • RETAIN — a stack deletion orphans the table instead of dropping it.
    //
    // None of the three replaces the table: an existing deployment picks
    // them up as an in-place update. Cost is PITR's per-GB charge on tables
    // that are megabytes. To tear a table down on purpose, flip deletion
    // protection off first — that is the point.
    const DURABLE = {
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    } as const;

    // --- RegistrationsTable -----------------------------------------------
    //
    // PK is `email` directly. Public-form rows are point-looked-up by
    // email (duplicate-submission idempotency) and listed by the admin
    // page (paginated Scan — public forms accumulate slowly). No GSI
    // needed at this scale; if a project ever wants a chronological
    // index, a GSI on createdAt can be added without breaking changes.
    //
    // No TTL: registrations are durable until an admin deletes them.
    this.registrationsTable = new dynamodb.Table(this, 'RegistrationsTable', {
      partitionKey: { name: 'email', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      ...DURABLE,
    });

    // --- OAuthStateTable --------------------------------------------------
    //
    // Single-table design within OAuth. The partition key carries a
    // discriminator prefix (`CLIENT#`, `CODE#`, `TOKEN#`, `REFRESH#`),
    // each entity kind written with the same shape:
    //
    //   CLIENT#<clientId>          — DCR-registered client metadata
    //   CODE#<authCode>            — auth code, 60s lifetime
    //   TOKEN#<accessTokenHash>    — full token row (refresh hash, userId,
    //                                clientId, scope, expiries, revokedAt)
    //   REFRESH#<refreshTokenHash> — small pointer item -> accessTokenHash
    //
    // `ttl` attribute (Unix seconds) is set on CODE, TOKEN, and REFRESH
    // items so DDB native TTL prunes expired rows asynchronously (~48 h
    // grace). Validity windows (60s codes, 24h access, 30d refresh) are
    // also filtered at read time — the app never trusts unexpired rows
    // to actually still be there.
    //
    // byUser-index: PK userId, SK createdAt. Drives /admin/integrations'
    // "list this user's active token connections." Sparse — only TOKEN
    // items set userId/createdAt, so CLIENT/CODE/REFRESH stay out.
    this.oauthStateTable = new dynamodb.Table(this, 'OAuthStateTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      ...DURABLE,
      timeToLiveAttribute: 'ttl',
    });

    this.oauthStateTable.addGlobalSecondaryIndex({
      indexName: 'byUser-index',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // --- IAM policy for the application Lambda ----------------------------
    //
    // Single inline-policy JSON output (kept small so the union with
    // aws-cognito's policy still fits the IAM 2KB ceiling on dev users).
    // Action set covers every operation the app does on these tables:
    //
    //   • GetItem / PutItem / DeleteItem — point lookups + writes
    //   • Query                          — byUser-index listing
    //   • Scan                           — admin list of registrations
    //   • UpdateItem                     — token rotation (set revokedAt)
    //
    // Index ARN uses /index/* wildcard so future GSIs work without policy
    // bumps.
    const appStatePolicy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: [
            'dynamodb:GetItem',
            'dynamodb:PutItem',
            'dynamodb:UpdateItem',
            'dynamodb:DeleteItem',
            'dynamodb:Query',
            'dynamodb:Scan',
          ],
          Resource: [
            this.registrationsTable.tableArn,
            `${this.registrationsTable.tableArn}/index/*`,
            this.oauthStateTable.tableArn,
            `${this.oauthStateTable.tableArn}/index/*`,
          ],
        },
      ],
    };

    new cdk.CfnOutput(this, 'iamPolicyForAppState', {
      value: JSON.stringify(appStatePolicy),
      description:
        'IAM inline policy for the application Lambda to access the registrations + oauth-state DDB tables',
    });

    new cdk.CfnOutput(this, 'registrationsTableName', {
      value: this.registrationsTable.tableName,
      description:
        'DynamoDB table holding public-form registration submissions (PK: email)',
    });

    new cdk.CfnOutput(this, 'oauthStateTableName', {
      value: this.oauthStateTable.tableName,
      description:
        'DynamoDB table holding OAuth/MCP machinery state (PK: pk = "<KIND>#<id>"). GSI: byUser-index.',
    });
  }
}
