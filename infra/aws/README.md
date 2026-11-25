# AWS infrastructure for a deployed environment

Four CloudFormation templates that create what stage 0 of
`docs/deployment-plan-2026-11-24.md` runs on, in Sydney (ap-southeast-2). They create
infrastructure only. They start no container, hold no secret and run no migration: the
deploy step and the database role set-up come after them and are not written yet.

**Status, 25 November 2026.** No stack has been created from these templates. They pass
`cfn-lint` 1.61, and five reviewers read them with a second reader checking each finding.
The server set-up script was run in parts in an Amazon Linux 2023 container. Nothing here
has run against AWS. Section 9 lists what is unverified pending runtime.

## 1. The account

Stage 0 goes into the existing account "Tinnox Production" (Michael, 25 Nov), which also
runs an unrelated server. That account is a _project_ of the AWS sign-up experience
launched in September 2026, and this shapes the templates:

| Fact | Consequence |
| --- | --- |
| AWS manages the organisation and its policies; the project cannot edit them | An "Australia only" policy cannot be added from here. AWS's own policy already confines the project to Sydney plus the global endpoints of two US Regions; Melbourne is refused too |
| Identity providers are forbidden (`iam:*Provider*`) | `delivery.yml` cannot be created: GitHub cannot take a role without a stored key |
| Both end with "Activate advanced features" in AWS Settings | It cannot be undone and only the owner can do it. It is Michael's decision |
| The CloudFormation console may attach a role of its own to a stack ("role manager") | That role may be unable to create IAM roles, and a stack keeps its role for life. See step 0 in section 3 |
| Another system shares the account | Own network, own security groups, own roles, own key for secrets. The server's role is denied every Parameter Store parameter outside its own path |

On 25 November the account had 13 IAM roles, all of them AWS's own; the other server has
no role. So today only the people who administer the account can read what the templates
protect. The protections matter once another system's role exists.

Until advanced features are activated there is no keyless way for GitHub to push images to
this account. Either they are activated and `delivery.yml` is created, or the server pulls
public images from GitHub's registry. This is open.

A spend limit, if one is ever set in AWS Settings, makes AWS refuse new stacks, keys, user
pools and database instances as the limit comes near. None is set today.

## 2. The templates

| Template | Stack name | Creates | About, per month |
| --- | --- | --- | --- |
| `environment.yml` | `tinnox-cms-test` | Network, the server with its fixed address and data disk, its role, log group, nightly disk snapshots, weekly patching, the key for secrets, optional DNS records | US$26 |
| `database.yml` | `tinnox-cms-test-database` | RDS PostgreSQL 17, one zone (the server's), 7 days of backups, in subnets with no route to the internet | US$21 |
| `identity.yml` | `tinnox-cms-test-identity` | Cognito user pool with an authenticator app required, the sign-in pages, the API's app client | US$0 |
| `delivery.yml` | `tinnox-cms-delivery` | Three image repositories, the GitHub identity provider, the deploy role. Needs advanced features | under US$1 |

The costs are estimates from the prices of 24 November 2026: server US$15.50 (t4g.small),
disks US$4.40, public address US$3.65, key US$1, snapshots and logs about US$1; database
US$18.25, its disk US$2.76, the master password's secret US$0.40. Together about US$47,
A$71 at the plan's rate. Two things can add to it: an RDS t4g instance bills CPU used above
its daily allowance (about US$0.075 for each vCPU-hour, and RDS cannot turn that off), and
the key costs US$1 more a month after each of its first two yearly rotations.

They are separate stacks because they live and die separately. The user pool must never
be deleted with a server; the database may have to be removed again (section 5); the
delivery stack cannot exist yet.

**Where this differs from the plan.** Container logs go to CloudWatch Logs, not to files
on the server: at this volume it costs cents and the logs survive the server. The disk is
two disks, 16 GB for the system and 30 GB for data, so the server can be replaced without
losing data. There is no CloudTrail trail and no budget alert yet (section 8). DNS records
are only created when the domain's zone is in Route 53 in this account, which it is not.

## 3. Creating the stacks

In Sydney, in this order. For every stack:

- Add the tags `project` = `tinnox-cms` and `environment` = `test`. Stack tags are copied to
  every resource that takes tags; the plan relies on the first to tell the CMS's
  resources and costs from the other system's.
- For the first creation choose **Stack failure options: Preserve successfully provisioned
  resources**. A failed stack then stops as it is, and what went wrong can be read
  before it is deleted.
- Turn on **stack termination protection** after the stack is complete, not in the wizard:
  a failed stack must be deleted before its name can be used again.

0. **Check which role CloudFormation will use.** On "Configure stack options", under
   Permissions, the console of a project account may show a role it attaches by itself.
   If that role cannot create IAM roles, `environment.yml` fails at `ServerRole` with
   "not authorized to perform: iam:CreateRole". If the console offers no way to use your
   own session instead, create the stacks from CloudShell, which runs them as you:

   ```bash
   aws cloudformation create-stack --stack-name tinnox-cms-test --template-body file://environment.yml --capabilities CAPABILITY_IAM --disable-rollback --tags Key=project,Value=tinnox-cms Key=environment,Value=test --parameters ParameterKey=ImageId,ParameterValue=ami-…
   ```

   Whichever way: afterwards the stack's "IAM role" must be empty. A role attached to a
   stack cannot be removed, and everyone who may update the stack can use it.

1. **`environment.yml`** as `tinnox-cms-test`. It needs the box "I acknowledge that
   CloudFormation might create IAM resources".
   - `ImageId`: the current Amazon Linux 2023 arm64 image. In the console: Systems Manager,
     Parameter Store, Public parameters, service `ami-amazon-linux-latest`, parameter
     `al2023-ami-kernel-default-arm64`; copy its value (`ami-…`). An x86 image fails at
     once, because the instance types are arm64.
   - `HostedZoneId`: empty unless the domain's DNS is in Route 53 in this account.
   - Leave `DataVolumeAttached` true, `DataVolumeSnapshotId` empty and
     `TerminationProtection` false.
   - The stack waits up to 30 minutes for the server to report how its set-up ended. While
     it waits, the set-up can be watched in a Session Manager session:
     `sudo tail -f /var/log/tinnox-bootstrap.log`.
   - If it fails: read that log, then delete the stack. The server must be stopped first
     (EC2 console, Instance state, Stop), or the data disk may refuse to detach.
   - When it is complete: update the stack with `TerminationProtection` true.
2. **DNS**, if `HostedZoneId` was empty: two A records, `app.test.tinnox-one.com.au` and
   `player.test.tinnox-one.com.au`, to the `ServerPublicIp` output. Optionally a CAA record
   `0 issue "letsencrypt.org"` on each. Caddy can only get certificates once these resolve.
3. **`database.yml`** as `tinnox-cms-test-database`. `EnvironmentStackName` is the name
   from step 1; a wrong name fails at once ("No export named …"). About 10 minutes.
4. **`identity.yml`** as `tinnox-cms-test-identity`. `DomainPrefix` must be unused by any
   AWS customer in the Region. If the stack fails on the domain, update the failed stack
   with another prefix; do not delete and re-create it, which would leave an empty user
   pool behind each time.
5. **`delivery.yml`**, only after advanced features are activated. First create the
   GitHub deployment environment `test`, limited to the main branch and with required
   reviewers: GitHub creates a missing environment, unprotected, for the first job that
   names it. It needs the same IAM acknowledgement as step 1.

## 4. What the templates leave to be done by hand

**Secrets and settings.** CloudFormation cannot create encrypted parameters. They are
written once, as SecureString with the key `alias/tinnox-cms-test-secrets`, under the path
`/tinnox-cms/test/`. Proposed layout, to be fixed by the deploy step:

| Parameter | Kind | Value |
| --- | --- | --- |
| `api/DATABASE_URL` | secret | `postgresql://tinnox_app:…@<DatabaseHost>:5432/tinnox?sslmode=verify-full&sslrootcert=<path to the RDS certificate bundle>` |
| `api/SESSION_SECRET`, `api/MEDIA_URL_HMAC_SECRET`, `api/PAIRING_CLIENT_KEY_SECRET` | secret | three different random values of 32 characters or more |
| `api/OIDC_CLIENT_SECRET` | secret | the app client's secret, read once in the Cognito console |
| `api/OIDC_ISSUER`, `api/OIDC_CLIENT_ID` | plain | the `Issuer` and `ClientId` outputs |
| `api/API_PUBLIC_ORIGIN`, `api/PORTAL_ORIGIN` | plain | the `PortalOrigin` output |
| `api/PLAYER_ORIGIN` | plain | the `PlayerOrigin` output |
| `api/OIDC_REDIRECT_URI` | plain | `<PortalOrigin>/api/auth/callback` |
| `api/OIDC_POST_LOGOUT_REDIRECT_URI` | plain | `<PortalOrigin>/` |
| `api/OIDC_MFA_AMR_VALUES` or `api/OIDC_MFA_ACR_VALUES` | plain | only after reading a real token (section 5) |
| `migrator/DATABASE_MIGRATOR_URL` | secret | as the first row, with `tinnox_migrator` |

The compose file also needs the three image names, the two host names and the path of the
API's settings file (`infra/deploy/compose.yml`); the deploy step supplies those.

The migrator's parameter must never go into the API's settings file: the API refuses to
start with it (`apps/api/src/config.ts`). The server's role can read the whole path,
including `migrator/`, because the plan runs migrations on the server. What keeps it from
the API is that containers cannot use the server's role (metadata hop limit of 1) and that
the deploy step gives it to the migration container only. Narrowing the role to `api/` is
possible once something other than the server fetches the migrator's parameter.

The database's master password is not among them. RDS keeps it in Secrets Manager
(`MasterUserSecretArn` output) and changes it every seven days. The server's role cannot
read it; anyone whose own policy allows `secretsmanager:GetSecretValue` on it can.

**What is on the data disk.** Docker keeps each container's settings, the API's secrets
among them, in plain text in its own directory, which is on the data disk, beside Caddy's
certificate keys. The nightly snapshots and the final snapshot contain them. The disk and
its snapshots are encrypted with the account's EBS key, so anyone in the account who may
create and attach a volume from a snapshot can read them.

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
- **Updates**: operating system updates install on Saturday at 18:30 UTC, which is Sunday
  04:30 in Sydney and 05:30 in summer, with a restart when one needs it; the containers
  come back by themselves. RDS has its own window, 17:00 to 18:00 UTC the same day, and
  backs up at 16:00. Whether the weekly run installs anything newer than the image's own
  release is not yet known (section 9).
- **A larger disk**: raise `DataVolumeSizeGiB`, then on the server `xfs_growfs /var/lib/tinnox`.
- **Compose** is pinned to 2.40.3 in the server set-up, with its checksum. To change it
  later, install the new file by hand on the server; changing the template alone does not
  rerun the set-up.
- **Never change on an existing stack**: `EnvironmentName`, `VpcCidr`,
  `DataVolumeSnapshotId`, `DomainPrefix`.

### Backups

The database keeps 7 days and can be restored to any minute of them. The data disk is
snapshotted every night, 7 kept, while the server runs: the file system recovers as after
a power cut. The two are not taken at the same moment, so a restore of both can leave
media rows without files or files without rows. Neither has been restored yet; the plan's
restore drill is in month two.

### Replacing the server

A new image id (`ImageId`) replaces the server. CloudFormation creates the new server
before it removes the old one, and the data disk cannot be attached to both, so:

1. Stop the server (EC2 console, Instance state, Stop). A disk detaches cleanly from a
   stopped server and can hang on a running one.
2. Update the stack with `DataVolumeAttached` false and `TerminationProtection` false.
3. Update the stack with the new `ImageId` and `DataVolumeAttached` true. The new server
   waits for the disk, keeps its contents and starts Docker on it.
4. Check `/var/log/tinnox-bootstrap.log` on the new server: on a replacement the stack
   does not wait for the set-up.
5. Deploy again. The new server has an empty `/etc/tinnox`, and the old containers are
   still defined on the data disk with the settings of the last deployment.
6. Update the stack with `TerminationProtection` true.

The fixed address moves to the new server. Certificates and media are on the data disk.

### Going back to a snapshot of the data disk

CloudFormation cannot change where an existing disk came from, so this is done beside the
stack:

1. In the EC2 console create a volume from the snapshot, in the server's zone, and attach
   it to the server as `/dev/sdg`.
2. On the server: `mkdir /mnt/restore && mount -o ro,nouuid /dev/sdg /mnt/restore`.
3. Stop the containers, copy back what is needed from `/mnt/restore`, start them.
4. `umount /mnt/restore`, then detach and delete the volume.

To rebuild a whole environment from a snapshot instead, create a new environment stack
with `DataVolumeSnapshotId` set and `DataVolumeSizeGiB` at least the snapshot's size.

### Restoring the database

A restore, to a point in time or from a snapshot, always makes a new instance outside the
stack. Give it the stack's subnet group and the security group
`tinnox-cms-test-database`, or the server cannot reach it. Then put the new host name
into `DATABASE_URL` and `DATABASE_MIGRATOR_URL` and deploy. RDS does not manage the
restored instance's master password until it is told to (Modify, "Manage master
credentials in AWS Secrets Manager"). Bringing the restored instance under the stack
(CloudFormation's "Import resources into stack") is not written yet.

### Deleting

1. Remove the A and CAA records of both host names if they were made by hand, and switch
   off or unpair the test players. The fixed address is released with the stack, and
   another AWS customer may later receive it.
2. Stop the server (EC2 console).
3. Update each stack with its protection parameter false, and turn off stack termination
   protection.
4. Delete the database stack, then the environment stack (the database uses the
   environment's network).

What stays behind on purpose, and keeps costing until removed by hand:

- the final database snapshot;
- the final data disk snapshot and the last nightly ones (cents each);
- the secrets key (US$1 a month), until its deletion is scheduled in the KMS console;
- the parameters under `/tinnox-cms/test/` (free). They stay encrypted with the old key:
  if the environment is created again, write each of them again with the new key;
- the user pool (free). A new identity stack makes a new, empty pool, in which every
  person is a new subject; to use the old pool again it must be imported into the new
  stack;
- for the delivery stack: the three repositories must be emptied before they can be deleted.

## 7. Limits of what these templates protect

- One server in one zone. If the server's hardware fails, AWS restarts it on other
  hardware with the same disks and address. If the zone is lost, the service is down until
  the zone returns, or until a new environment is built from the last snapshots in the
  other zone, by hand. The plan accepts this for stage 0.
- The snapshot role carries AWS's managed policy, which can snapshot and delete snapshots
  of any volume in the account. Only the schedule is limited to this environment's disk.
- The deploy role trusts a GitHub subject that proves the repository and the deployment
  environment, not the branch or the event. The branch rule and the reviewers are set in
  GitHub.
- The sign-in pages are Cognito's and are served through AWS's own edge network. The pool,
  its users and its tokens are in Sydney.

## 8. Not in these templates

- The deploy step, the RDS role set-up and the migration step.
- CloudTrail. The account has no trail; the console's event history keeps 90 days.
- A budget alert. A budget for the CMS alone needs its tag activated for cost allocation,
  which only the organisation's management account can do.
- Alarms, dashboards, VPC flow logs: monitoring is left out of stage 0 on purpose.
- S3 for media (month two), e-mail (off), a second zone, Melbourne.

## 9. Unverified pending runtime

- Everything, in the sense that no stack has been created. In particular:
- Which role the CloudFormation console uses in a project account, and what it may do
  (section 3, step 0).
- That a project account allows each resource type here. AWS's published policies for
  projects allow these services and forbid IAM paths under `/managed/`, which the
  templates do not use; identity providers are the one known refusal.
- On a real Amazon Linux 2023 instance: the name under which the data disk appears
  (`/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_vol…`), the root device name
  `/dev/xvda`, and that the set-up's report reaches the stack. In a container the
  packages installed, Compose 2.40.3 verified against its checksum and ran this compose
  file on Docker 25, and Docker started with this configuration.
- That a metadata hop limit of 1 keeps containers from the server's credentials.
- `AWS-RunPatchBaseline` on Amazon Linux 2023. An instance stays on the release its image
  was built with unless told otherwise, so the weekly run may install nothing newer. Check
  after the first Sunday with `dnf check-release-update`.
- `EngineVersion: '17'` (the major version alone) on creation.
- Managed login with only `ALLOW_REFRESH_TOKEN_AUTH` among the explicit flows, the first
  sign-in of a user created by an administrator when account recovery is `admin_only`,
  and what the ID token then contains.
- The exact subject of a GitHub token for a deployment environment in the immutable
  format (the prefix is confirmed, the `:environment:<name>` ending is inferred).
