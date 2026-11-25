# AWS infrastructure for a deployed environment

Four CloudFormation templates that create what stage 0 of
`docs/deployment-plan-2026-11-24.md` runs on, in Sydney (ap-southeast-2). They create
infrastructure only. They start no container, hold no secret and run no migration: the
deploy step and the database role set-up come after them and are not written yet.

**Status, 25 November 2026.** All four stacks exist in Sydney, created from CloudShell and
complete on the first attempt: `tinnox-cms-test` from `environment.yml` (the server's
set-up reported success), `tinnox-cms-test-database` from `database.yml` (PostgreSQL 17.9,
available), `tinnox-cms-test-identity` from `identity.yml` (an empty user pool) and
`tinnox-cms-delivery` from `delivery.yml` (three empty image repositories, the GitHub
identity provider, the deploy role; the fourth repository comes with the next update). Stack termination protection is on for all four, and
the server's termination protection too. The GitHub deployment environment `test` exists:
main branch only, one required reviewer; repository administrators can bypass it.
Nothing has been deployed: no image pushed, no role taken by GitHub, no user signed in.
Section 9 lists what is unverified pending runtime.

## 1. The account

Stage 0 goes into the existing account "Tinnox Production" (Michael, 25 Nov), which also
runs an unrelated server. The account began as a _project_ of the AWS sign-up experience
launched in September 2026, with AWS managing its organisation. On 25 November Michael
activated "advanced features", which cannot be undone. TINNOX now administers the
organisation: the management account, "Tinnox Production" and "Tinnox Identity Delegated
Admin", which AWS added for sign-in administration. As read in the console that day:

| Fact | Consequence |
| --- | --- |
| The organisation's policies are TINNOX's own ("customer managed") | Nobody else maintains them. A change to them is a change to every account |
| The region policy is attached to the whole organisation: Sydney only, plus the global services that answer from two US Regions | This is the "Australia only" lock. Melbourne is refused until the policy names it. It does not bind the management account, so nothing is built there |
| Identity providers are no longer forbidden | `delivery.yml` can be created: GitHub takes a role with no stored key |
| Roles under the IAM path `/managed/` are protected | The templates use no such path |
| The CloudFormation console may attach a role of its own to a stack ("role manager") | That role may be unable to create IAM roles, and a stack keeps its role for life. See step 0 in section 3. Role manager can now be turned off per account |
| Another system shares the account | Own network, own security groups, own roles, own key for secrets. The server's role is denied every Parameter Store parameter outside its own path |

On 25 November the account had 13 IAM roles, all of them AWS's own; the other server has
no role. So today only the people who administer the account can read what the templates
protect. The protections matter once another system's role exists.

Spend limits ended with activation. A budget alert takes their place and is not set yet
(section 8).

## 2. The templates

| Template | Stack name | Creates | About, per month |
| --- | --- | --- | --- |
| `environment.yml` | `tinnox-cms-test` | Network, the server with its fixed address and data disk, its role, log group, nightly disk snapshots, weekly patching, the key for secrets, the release document, optional DNS records | US$26 |
| `database.yml` | `tinnox-cms-test-database` | RDS PostgreSQL 17, one zone (the server's), 7 days of backups, in subnets with no route to the internet | US$21 |
| `identity.yml` | `tinnox-cms-test-identity` | Cognito user pool with an authenticator app required, the sign-in pages, the API's app client | US$0 |
| `delivery.yml` | `tinnox-cms-delivery` | Four image repositories, the GitHub identity provider, the deploy role | under US$1 |

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

0. **Create the stacks from CloudShell, not from the console's wizard.** While role
   manager is on in this account (it is), the wizard's "Permissions" section creates an
   IAM role and attaches it to the stack; it offers an existing role or a new one, but
   not your own session. A role attached to a stack cannot be removed, and everyone who
   may update the stack can use it. CloudShell runs the stack as you. The wizard is
   still useful for one thing: uploading the template on its first page stores it in
   the bucket `cf-templates-…-ap-southeast-2` and shows its URL; then cancel the wizard.

   ```bash
   aws cloudformation create-stack --stack-name tinnox-cms-test --template-url https://s3.ap-southeast-2.amazonaws.com/cf-templates-…/…-environment.yml --capabilities CAPABILITY_IAM --disable-rollback --tags Key=project,Value=tinnox-cms Key=environment,Value=test --parameters ParameterKey=ImageId,ParameterValue=ami-…
   ```

   `--disable-rollback` is the wizard's "Preserve successfully provisioned resources".
   Afterwards the stack's "IAM role" must be empty (`RoleARN` in `describe-stacks`).

1. **`environment.yml`** as `tinnox-cms-test`. It creates an IAM role, hence
   `--capabilities CAPABILITY_IAM`.
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
5. **`delivery.yml`** as `tinnox-cms-delivery`. First create the
   GitHub deployment environment `test`, limited to the main branch and with required
   reviewers: GitHub creates a missing environment, unprotected, for the first job that
   names it. It needs `--capabilities CAPABILITY_IAM`, as step 1 does.

## 4. Before the first release, and what a release does

**`bootstrap.sh`**, once per environment, by a person in CloudShell with their own rights:

```bash
git clone https://github.com/tinnox-au/tinnox-cms.git && cd tinnox-cms && infra/aws/bootstrap.sh test
```

It creates the three database roles and the database `tinnox` (`rds-roles.sql`, the RDS
form of `infra/postgres/init/01-roles.sh`), and writes the settings below to Parameter
Store under `/tinnox-cms/test/`, the secrets as SecureString with the key
`alias/tinnox-cms-test-secrets`. It may be run again: it keeps every secret that exists,
and changes the database passwords only with `--rotate-database-passwords`, after which a
release is needed so the API reads its new one.

| Parameter | Kind | Value |
| --- | --- | --- |
| `api/DATABASE_URL` | secret | `postgresql://tinnox_app:…@<DatabaseHost>:5432/tinnox?sslmode=verify-full&sslrootcert=/etc/ssl/rds/ap-southeast-2-bundle.pem` |
| `api/SESSION_SECRET`, `api/MEDIA_URL_HMAC_SECRET`, `api/PAIRING_CLIENT_KEY_SECRET` | secret | 256 random bits each, made once |
| `api/OIDC_CLIENT_SECRET` | secret | the app client's secret, read from Cognito |
| `api/OIDC_ISSUER`, `api/OIDC_CLIENT_ID` | plain | the `Issuer` and `ClientId` outputs |
| `api/API_PUBLIC_ORIGIN`, `api/PORTAL_ORIGIN` | plain | the `PortalOrigin` output |
| `api/PLAYER_ORIGIN` | plain | the `PlayerOrigin` output |
| `api/OIDC_REDIRECT_URI` | plain | `<PortalOrigin>/api/auth/callback` |
| `api/OIDC_POST_LOGOUT_REDIRECT_URI` | plain | `<PortalOrigin>/` |
| `api/OIDC_MFA_AMR_VALUES` | plain | `mfa`, until a real token has been read (section 5) |
| `migrator/DATABASE_MIGRATOR_URL` | secret | as the first row, with `tinnox_migrator` |

Every parameter directly under `api/` becomes a setting of the API at the next release,
under the parameter's last name. A value may contain letters, digits and
`_ . : / @ ? & = % + , ~ -` only; the release refuses anything else by name, because the
settings file would change it on the way. The script's own secrets are hexadecimal.

How the script handles secrets: database passwords are made in CloudShell and go only
into the two connection strings; the database gets SCRAM verifiers, so no password is in
the SQL, the server's command history or the database's log. Parameter Store is the
truth: a new password is stored first, and every run sets the database's passwords to
what is stored, so a run that stops half way is repaired by running the script again.
The master password is copied to `/tinnox-cms/test/tmp/master-password` for the minutes
the server needs it and deleted again, also when the script fails. If the CloudShell
session itself dies, nothing deletes it: the script warns when it could not, and the
parameter is then deleted by hand. On the server the master password is a file in `/run`
(memory) for psql, never an environment variable.

**A release** is started from GitHub: Actions, Deploy, Run workflow, on `main`
(`.github/workflows/deploy.yml`). A reviewer of the deployment environment `test` approves
it. The job builds four images for the commit (API, web, media worker and the release
image, which is the API's code with the migrations, `infra/deploy/compose.yml` and
`infra/deploy/release.sh`), pushes them, and starts the release document
`tinnox-cms-test-release` on the server with the commit id. On the server, `release.sh`
of that commit pulls the images, writes the API's settings file, stops the API, runs the
migrations, starts everything and waits for `/readyz`. If a migration fails the API stays
stopped until a release succeeds. Its output is in the workflow run and in
`/var/log/tinnox-release.log`.

The GitHub deployment environment needs three variables, none of them secret:
`AWS_REGION` (`ap-southeast-2`), `AWS_DEPLOY_ROLE_ARN` (the `DeployRoleArn` output) and
`API_PUBLIC_ORIGIN` (the `PortalOrigin` output).

**The migrator's connection string** must never reach the API: the API refuses to start
with it (`apps/api/src/config.ts`). `release.sh` gives it to the one
migration container as a file in `/run` (memory), removed when the migrations end, and to
nothing else; that container is the release image, not the API's. It is not passed in the
environment, because Docker keeps a container's environment on the data disk.
The server's role can read the whole path, `migrator/` included, because the migrations
run on the server; containers cannot use the server's role (metadata hop limit of 1).

The database's master password is not among the parameters. RDS keeps it in Secrets
Manager (`MasterUserSecretArn` output) and changes it every seven days. The server's role
cannot read it; anyone whose own policy allows `secretsmanager:GetSecretValue` on it can.

**What is on the data disk.** Docker keeps each container's settings, the API's secrets
among them, in plain text in its own directory, which is on the data disk, beside Caddy's
certificate keys. The nightly snapshots and the final snapshot contain them. The disk and
its snapshots are encrypted with the account's EBS key, so anyone in the account who may
create and attach a volume from a snapshot can read them.

**Reaching the database.** Only the server can (security group). A person runs `psql`
from a container on the server, in a Session Manager session, or forwards a port through
the server with the `AWS-StartPortForwardingSessionToRemoteHost` document.

**The incident scripts** (`scripts/revoke-all-sessions.sql`,
`scripts/revoke-subject-sessions.sql`) run as `tinnox_migrator` on RDS, with the
connection string in `migrator/DATABASE_MIGRATOR_URL`. There is no superuser, and the
master user cannot take `tinnox_definer`: it created the roles but holds no `SET` on
them, and `rds-roles.sql` takes its `SET` on `tinnox_migrator` away again.

**TLS to the database.** RDS refuses connections without TLS. The API image and the
release image carry the certificate authorities of RDS in Sydney at
`/etc/ssl/rds/ap-southeast-2-bundle.pem`, pinned by checksum in `apps/api/Dockerfile`;
the connection strings name that file with `sslmode=verify-full`. When AWS changes the
bundle the image build fails until the checksum is updated, in the Dockerfile and in
`bootstrap.sh`.

**People.** Users are created in the Cognito console (or with `AdminCreateUser`, with
`DesiredDeliveryMediums EMAIL`). A person signs in with the e-mail address and sets up
an authenticator app at the first sign-in.

## 5. Open before the first deployment

1. **RDS and the `BYPASSRLS` role: settled, RDS accepts it.** Tested on 25 November on
   the new instance (PostgreSQL 17.9) as the master user, from the server, over TLS 1.3
   with `sslmode=verify-full` and the RDS bundle: `CREATE ROLE … NOLOGIN BYPASSRLS` with
   the same attributes as `infra/postgres/init/01-roles.sh` succeeded and the role had
   `rolbypassrls`, although the master user itself has neither superuser nor `BYPASSRLS`.
   The grant `WITH INHERIT FALSE, SET TRUE` and the role's `lock_timeout` succeeded too.
   One difference from the local script: `CREATE DATABASE … OWNER tinnox_migrator` is
   refused ("must be able to SET ROLE") until
   `GRANT tinnox_migrator TO CURRENT_USER WITH SET TRUE` has run. The test used throwaway
   roles and dropped them; the real roles and databases are not created yet. Still: do
   not grant `rds_superuser` to anything.
2. **Sign-out.** The pool's discovery document does publish an `end_session_endpoint`
   (`…/logout` on the sign-in pages; read 25 November), so the API will build its
   standard sign-out address (`post_logout_redirect_uri` with `id_token_hint` or
   `client_id`). Whether Cognito accepts those parameters, or only its own
   `client_id` and `logout_uri`, has not been tried. If it refuses, the CMS session
   ends but Cognito's own lasts up to an hour, so the same browser can sign in again
   without a password, and `apps/api/src/auth/oidc.ts` needs a change.
3. **Proof of the second factor.** In production the API refuses to start without
   `OIDC_MFA_ACR_VALUES` or `OIDC_MFA_AMR_VALUES`, and refuses every sign-in whose token
   does not match. Cognito documents `acr` `urn:cognito:loa:4` and `amr`
   `["pwd","otp","mfa"]` for a password plus an authenticator code through managed login,
   but says the claims are "rolling out gradually". Read a real token before choosing.
4. **The provisioning tool** reads users from Keycloak only (`scripts/lib/idp.ts`).
5. **The first release.** The scripts and the workflow are written and rehearsed (section
   9) but have not run against AWS: the delivery and environment stacks must be updated
   first (the release repository, the role's right to start a release, the release
   document), then `bootstrap.sh`, the three GitHub variables, DNS, and a run of Deploy.

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
- for the delivery stack: every image repository must be emptied before it can be deleted
  (four once the stack is updated: `api`, `web`, `media-worker`, `release`).

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
- Whoever can push an image and start the release document controls the server and the
  database: the release script comes from the image and runs as root, and the migration
  container is given the migrator's connection string. That is the deploy role, which
  only a run of this repository in the GitHub environment `test` can take, after a
  reviewer approves it, from `main`. Repository administrators can bypass the reviewer.
- The deploy role can read the output of every Systems Manager command in the account and
  Region, not only its own: AWS offers no narrower permission. The release prints no
  secret; do not print one in any other command either.
- A release has a short outage: the API is stopped while the migrations run.
- The sign-in pages are Cognito's and are served through AWS's own edge network. The pool,
  its users and its tokens are in Sydney.

## 8. Not in these templates

- CloudTrail. The account has no trail; the console's event history keeps 90 days.
- A budget alert. A budget for the CMS alone needs its tag activated for cost allocation,
  which is done in the organisation's management account.
- Alarms, dashboards, VPC flow logs: monitoring is left out of stage 0 on purpose.
- S3 for media (month two), e-mail (off), a second zone, Melbourne.

## 9. Unverified pending runtime

- The release path has been rehearsed on a developer's machine, not on AWS (25 November):
  the role script against PostgreSQL 17.12 with a master user that is not a superuser;
  the four images built; and the release document's script with `release.sh` run in an
  Amazon Linux 2023 container with Compose 2.40.3 against that database, with a stand-in
  for the AWS CLI. The migrations applied, the three containers came up healthy, a
  repeated release kept them, and the failure cases stopped where they should (a value
  the settings file cannot carry, Parameter Store unreachable, a migration that cannot
  connect, a second release started while one runs). The role script refused a role with
  the wrong attributes and a role with an unexpected membership. Not rehearsed: `bootstrap.sh` itself (it needs AWS), the workflow, the role's
  permissions, the release document inside Systems Manager, and RDS accepting SCRAM
  verifiers in `ALTER ROLE … PASSWORD`.
- Creating the four stacks on 25 November showed: the organisation's policies allow
  their resource types, including the IAM roles and the identity provider; the data disk
  appears under the by-id name the set-up waits for; the set-up's report reaches the
  stack; and `EngineVersion: '17'` is accepted (it gave 17.9).
- The migrations and the `sec.*` functions on RDS: the server reaches the database and
  RDS accepts the roles (section 5), but no migration has run there.
- The organisation's resource control policy was not read.
- That GitHub can take the deploy role: the provider and the role exist, and the role's
  trust names the subject `…:environment:test`, but no workflow has tried.
- What the server looks like from inside: nobody has opened a session on it yet. The
  set-up checks the mount, Docker and Compose before it reports success, and it did.
- That a metadata hop limit of 1 keeps containers from the server's credentials.
- `AWS-RunPatchBaseline` on Amazon Linux 2023. An instance stays on the release its image
  was built with unless told otherwise, so the weekly run may install nothing newer. Check
  after the first Sunday with `dnf check-release-update`.
- Managed login with only `ALLOW_REFRESH_TOKEN_AUTH` among the explicit flows, the first
  sign-in of a user created by an administrator when account recovery is `admin_only`,
  and what the ID token then contains.
- The exact subject of a GitHub token for a deployment environment in the immutable
  format (the prefix is confirmed, the `:environment:<name>` ending is inferred).
