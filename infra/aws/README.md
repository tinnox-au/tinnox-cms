# AWS infrastructure for a deployed environment

Four CloudFormation templates that create what stage 0 of
`docs/deployment-plan-2026-11-24.md` runs on, in Sydney (ap-southeast-2). They create
infrastructure only. They start no container, hold no secret and run no migration: the
deploy step and the database role set-up come after them and are not written yet.

**Status, 25 November 2026.** No stack has been created from these templates. They pass
`cfn-lint` 1.61 and were reviewed by reading; nothing here has run against AWS. Section 8
lists what is unverified pending runtime.

## 1. The account

Stage 0 goes into the existing account "Tinnox Production" (Michael, 25 Nov), which also
runs an unrelated server. That account is a _project_ of the AWS sign-up experience
launched in September 2026, and this shapes the templates:

| Fact | Consequence |
| --- | --- |
| AWS manages the organisation and its policies; the project cannot edit them | An "Australia only" policy cannot be added from here. AWS's own policy already confines the project to Sydney plus the global endpoints of two US Regions. Each template also refuses to be created outside Sydney and Melbourne |
| Identity providers are forbidden (`iam:*Provider*`) | `delivery.yml` cannot be created: GitHub cannot take a role without a stored key |
| Both end with "Activate advanced features" in AWS Settings | It cannot be undone and only the owner can do it. It is Michael's decision |
| Another system shares the account | Own network, own security groups, own roles, own key for secrets. The server's role is denied every Parameter Store parameter outside its own path |

Until advanced features are activated there is no keyless way for GitHub to push images to
this account. Either they are activated and `delivery.yml` is created, or the server pulls
public images from GitHub's registry. This is open.

## 2. The templates

| Template | Stack name | Creates | About, per month |
| --- | --- | --- | --- |
| `environment.yml` | `tinnox-cms-test` | Network, the server with its fixed address and data disk, its role, log group, nightly disk snapshots, weekly patching, the key for secrets, optional DNS records | US$26 |
| `database.yml` | `tinnox-cms-test-database` | RDS PostgreSQL 17, one zone, 7 days of backups, in subnets with no route to the internet | US$21 |
| `identity.yml` | `tinnox-cms-test-identity` | Cognito user pool with an authenticator app required, the sign-in pages, the API's app client | US$0 |
| `delivery.yml` | `tinnox-cms-delivery` | Three image repositories, the GitHub identity provider, the deploy role. Needs advanced features | under US$1 |

The costs are estimates from the prices of 24 November 2026: server US$15.50 (t4g.small),
disks US$4.40, public address US$3.65, key US$1, snapshots and logs about US$1; database
US$18.25, its disk US$2.76, the master password's secret US$0.40. Together about US$47,
A$71 at the plan's rate.

They are separate stacks because they live and die separately. The user pool must never
be deleted with a server; the database may have to be removed again (section 5); the
delivery stack cannot exist yet.

## 3. Creating the stacks

Create them in the CloudFormation console, in Sydney, in this order. Turn on **stack
termination protection** for each.

1. **`environment.yml`** as `tinnox-cms-test`. It needs the box "I acknowledge that
   CloudFormation might create IAM resources".
   - `ImageId`: the current Amazon Linux 2023 arm64 image. In the console: Systems Manager,
     Parameter Store, Public parameters, service `ami-amazon-linux-latest`, parameter
     `al2023-ami-kernel-default-arm64`; copy its value (`ami-…`).
   - `HostedZoneId`: empty unless the domain's DNS is in Route 53 in this account.
   - Leave `DataVolumeAttached` true and `DataVolumeSnapshotId` empty.
   - The stack waits up to 30 minutes for the server to report that its set-up finished,
     and fails if it reports a failure. The set-up log is `/var/log/tinnox-bootstrap.log`.
2. **DNS**, if `HostedZoneId` was empty: two A records, `app.test.tinnox-one.com.au` and
   `player.test.tinnox-one.com.au`, to the `ServerPublicIp` output. Optionally a CAA record
   `0 issue "letsencrypt.org"` on each. Caddy can only get certificates once these resolve.
3. **`database.yml`** as `tinnox-cms-test-database`. `EnvironmentStackName` is the name
   from step 1. About 10 minutes.
4. **`identity.yml`** as `tinnox-cms-test-identity`. `DomainPrefix` must be unused by any
   AWS customer in the Region; if the stack fails on the domain, choose another.
5. **`delivery.yml`**, only after advanced features are activated.

## 4. What the templates leave to be done by hand

**Secrets and settings.** CloudFormation cannot create encrypted parameters. They are
written once, as SecureString with the key `alias/tinnox-cms-test-secrets`, under the path
`/tinnox-cms/test/`. The server's role can read that path and nothing else. Proposed
layout, to be fixed by the deploy step:

| Parameter | Kind | Value |
| --- | --- | --- |
| `api/DATABASE_URL` | secret | `postgresql://tinnox_app:…@<DatabaseHost>:5432/tinnox?sslmode=verify-full&sslrootcert=<path to the RDS certificate bundle>` |
| `api/SESSION_SECRET`, `api/MEDIA_URL_HMAC_SECRET`, `api/PAIRING_CLIENT_KEY_SECRET` | secret | three different random values of 32 characters or more |
| `api/OIDC_CLIENT_SECRET` | secret | the app client's secret, read once in the Cognito console |
| `api/OIDC_ISSUER`, `api/OIDC_CLIENT_ID` | plain | the `Issuer` and `ClientId` outputs |
| `api/OIDC_MFA_AMR_VALUES` or `api/OIDC_MFA_ACR_VALUES` | plain | only after reading a real token (section 8) |
| `migrator/DATABASE_MIGRATOR_URL` | secret | as above with `tinnox_migrator`. Read by the migration step only; it never goes into the API's settings file (`apps/api/src/config.ts` refuses to start with it) |

The database's master password is not among them. RDS keeps it in Secrets Manager
(`MasterUserSecretArn` output) and changes it every seven days; the server's role cannot
read it.

**The database roles.** `infra/postgres/init/01-roles.sh` cannot run unchanged: the RDS
master user is not a superuser. The set-up for RDS has to grant the master user `SET` on
`tinnox_migrator` before `CREATE DATABASE tinnox OWNER tinnox_migrator`, and must not
create `tinnox_test`.

**Reaching the database.** Only the server can (security group). A person runs `psql`
from a container on the server, in a Session Manager session, or forwards a port through
the server with the `AWS-StartPortForwardingSessionToRemoteHost` document.

**TLS to the database.** RDS refuses connections without TLS. The connection string
needs `sslmode=verify-full` and `sslrootcert` pointing at
`https://truststore.pki.rds.amazonaws.com/ap-southeast-2/ap-southeast-2-bundle.pem`,
which is in neither image today. Without the bundle the API cannot connect at all.

**People.** Users are created in the Cognito console (or with `AdminCreateUser`, with
`DesiredDeliveryMediums EMAIL`). A person signs in with the e-mail address and sets up
an authenticator app at the first sign-in.

## 5. Open before the first deployment

1. **RDS and the `BYPASSRLS` role.** `CREATE ROLE tinnox_definer NOLOGIN BYPASSRLS` as the
   RDS master user is expected to be refused: PostgreSQL lets only a superuser or a
   `BYPASSRLS` role give that attribute, and the master user is neither. Every tenant table
   forces row-level security, so the `sec.*` functions depend on it. Test this first, on
   the new instance. If it is refused, the plan's fallback is PostgreSQL in a container on
   the server: delete the database stack (`DeletionProtection` false first). Do not grant
   `rds_superuser` to anything and do not weaken the policies.
2. **Sign-out.** The API builds a standard sign-out address from `end_session_endpoint`,
   which Cognito is not known to publish. Without it the CMS session ends but Cognito's
   own session lasts up to an hour, so the same browser can sign in again without a
   password. Cognito's `/logout?client_id=…&logout_uri=…` needs a code change in
   `apps/api/src/auth/oidc.ts`.
3. **Proof of the second factor.** In production the API refuses to start without
   `OIDC_MFA_ACR_VALUES` or `OIDC_MFA_AMR_VALUES`, and refuses every sign-in whose token
   does not match. Cognito documents `acr` `urn:cognito:loa:4` and `amr`
   `["pwd","otp","mfa"]` for a password plus an authenticator code through managed login,
   but says the claims are "rolling out gradually". Read a real token before choosing.
4. **The provisioning tool** reads users from Keycloak only (`scripts/lib/idp.ts`).
5. **How images arrive** (section 1), and with it the deploy step.

## 6. Running it

- **Signing in to the server**: Systems Manager, Session Manager. There is no SSH and no
  key pair.
- **Logs**: CloudWatch Logs group `/tinnox-cms/test`, one stream per container, kept 30
  days. `docker logs` on the server shows the latest lines.
- **Updates**: operating system updates install every Sunday about 04:30 Sydney time
  (05:30 in summer), with a restart when one needs it; the containers come back by
  themselves. RDS applies minor versions in its window an hour or so earlier.
- **Backups**: the database keeps 7 days and can be restored to any minute of them, as a
  new instance. The data disk is snapshotted every night, 7 kept. Neither has been
  restored yet; the plan's restore drill is in month two.
- **A larger disk**: raise `DataVolumeSizeGiB`, then on the server `xfs_growfs /var/lib/tinnox`.
- **Compose** is pinned to 2.40.3 in the server set-up, with its checksum. To change it
  later, install the new file by hand on the server; changing the template alone does not
  rerun the set-up.

### Replacing the server

A new image id (`ImageId`) replaces the server. CloudFormation creates the new server
before it removes the old one, and the data disk cannot be attached to both, so:

1. On the server: `docker compose … down`, `systemctl stop docker`, `umount /var/lib/tinnox`.
2. Update the stack with `DataVolumeAttached` false and `TerminationProtection` false.
3. Update the stack with the new `ImageId`, `DataVolumeAttached` true and
   `TerminationProtection` true. The new server finds the disk, keeps its contents and
   starts Docker on it; the containers that were defined come back.
4. Check `/var/log/tinnox-bootstrap.log` on the new server: on a replacement the stack
   does not wait for the set-up.

The fixed address moves to the new server. Certificates and media are on the data disk.

### Going back to a snapshot of the data disk

Steps 1 and 2 above, then update with `DataVolumeSnapshotId` set to the snapshot and
`DataVolumeAttached` true. The disk that is replaced is snapshotted first.

### Deleting

Update each stack with its protection parameter false, turn off stack termination
protection, then delete the database stack before the environment stack (it uses the
environment's network). What stays behind on purpose, and keeps costing until removed by
hand: the final database snapshot, the final data disk snapshot and the last nightly ones,
the secrets key (US$1 a month), the user pool, and the parameters under `/tinnox-cms/test/`.

## 7. Not in these templates

- The deploy step, the RDS role set-up and the migration step.
- CloudTrail. The account has no trail; the console's event history keeps 90 days.
- A budget alert. A budget for the CMS alone needs its tag activated for cost allocation,
  which only the organisation's management account can do.
- Alarms, dashboards, VPC flow logs: monitoring is left out of stage 0 on purpose.
- S3 for media (month two), e-mail (off), a second zone, Melbourne.

## 8. Unverified pending runtime

- Everything, in the sense that no stack has been created. In particular:
- That a project account allows each resource type here. AWS's published policies for
  projects allow these services and forbid IAM paths under `/managed/`, which the
  templates do not use; identity providers are the one known refusal.
- The server set-up script on a real Amazon Linux 2023 instance, including the name under
  which the data disk appears and Compose 2.40.3 with Docker 25.
- That a metadata hop limit of 1 keeps containers from the server's credentials.
- `AWS-RunPatchBaseline` on Amazon Linux 2023 with the default baseline.
- `EngineVersion: '17'` (the major version alone) on creation.
- Managed login with only `ALLOW_REFRESH_TOKEN_AUTH` among the explicit flows, the first
  sign-in of a user created by an administrator when account recovery is `admin_only`,
  and what the ID token then contains.
- The exact subject of a GitHub token for a deployment environment in the immutable
  format (the prefix is confirmed, the `:environment:<name>` ending is inferred).
