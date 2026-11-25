# TINNOX CMS: deployment plan (draft)

**Prepared:** 24 November 2026
**Card:** CMS-37
**Status:** DRAFT for Michael's review. Nothing here is provisioned or approved.
**Currency:** provider rates are USD; AUD uses the planning rate of US$1 = A$1.50 from
`deployment-cost-comparison-2026-11-15.md`. Figures exclude GST. Prices were checked on
24 November 2026 from third-party price trackers and AWS pages; confirm them in the AWS
pricing calculator before committing.

## 1. Decisions this plan rests on

| Decision | Choice | Source |
| --- | --- | --- |
| Data location | Australia only | DEC-13, decided by the client |
| Provider and region | AWS Sydney (`ap-southeast-2`); Melbourne (`ap-southeast-4`) for backup copies later | Proposed in DEC-13; taken as the working choice here |
| AWS account | Stage 0 runs in the existing account "Tinnox Production", beside an unrelated server | Decided (Michael, 25 Nov), against the recommendation of a new member account; see section 3.4 |
| Media delivery | Direct from Sydney, no CDN | Michael, 24 Nov |
| Identity provider | Amazon Cognito in Sydney, after a short trial; Keycloak on the host if the trial fails | Michael accepted the recommendation, 24 Nov |
| E-mail | Amazon SES Sydney, when alerts are switched on | Michael accepted the recommendation, 24 Nov |
| Logs and monitoring | AWS CloudWatch first; a hosted product with an Australian region later | Michael accepted the recommendation, 24 Nov |
| Outside checks and paging | Better Stack, when there is a customer | Michael accepted the recommendation, 24 Nov |
| Availability target | 99.9%, at most 5 to 15 minutes of data lost, restore in 4 hours: for paying customers, not for stage 0 | Recommended, 24 Nov |
| Incident owner | Michael | Michael, 24 Nov |
| Native players | Linux only for now | Michael, 24 Nov |

DEC-13 and acceptance test NF-07 still name CloudFront and must be amended when this plan is
agreed.

## 2. Three stages

The system is single-host today: media is on local disk, the API and the media worker exchange
jobs through a shared folder, rate limits are in memory, and only one worker can run. Stage 0
deploys it with the production building blocks that work today. Stages 1 and 2 need code
changes first.

| Stage | When | Who uses it | Shape | Monthly cost |
| --- | --- | --- | --- | --- |
| 0. Internal test environment | Now, for about 2 months | TINNOX only, synthetic data | One small server, managed database, Cognito sign-in; S3 media in the second month | About A$70 |
| 1. Pilot | Before the first external customer | A few supervised customers | Stage 0 plus Melbourne backups, monitoring, e-mail and the security gates | About A$255 at 25 players (cost study, option A) |
| 2. Production | Before an uptime promise | Paying customers | Two API copies in two data centres, database with failover | About A$620 to A$870 at 25 to 100 players (cost study, option C) |

Stage 0 is not thrown away. It grows into stage 1: the same account, network, database,
pipeline and sign-in, with the missing parts added. When production exists, the stage 0 server
becomes the staging environment that every release passes through first.

## 3. Stage 0: internal test environment

### 3.1 Why deploy now

Production mode has never run. The API has start-up rules that only apply with
`NODE_ENV=production` (https origins, no development secrets, no development sign-in realm,
proof of MFA), and none of the following has been exercised: TLS, secure cookies, real
hostnames, the reverse-proxy headers, a deploy pipeline, migrations against a database that
keeps its data between releases, a managed database, or any sign-in provider other than the
local Keycloak. No container image exists for the API.

Each of these is an unknown that is cheap to find now and expensive to find the week before a
customer. Stage 0 also gives the Raspberry Pi check (CMS-4) and the Linux player a real HTTPS
server in place of an SSH tunnel to a laptop.

### 3.2 What runs

One EC2 instance in Sydney, running three containers:

- Caddy: TLS with free Let's Encrypt certificates; serves the portal and player bundles on two
  hostnames; forwards `/api` on the portal hostname to the API; sends the security headers
  listed in `apps/portal/README.md`.
- The API (a new image).
- The media worker (the existing image, still with no network).

Beside the instance:

- PostgreSQL 17 on RDS, one zone, smallest size, not reachable from the internet, with the
  three roles and 7 days of automatic backups.
- A Cognito user pool in Sydney for sign-in.
- Media: on the instance's disk for the first month. In the second month an S3 adapter is
  written and media moves to a private Sydney bucket.

### 3.3 Stage 0 compared with production

| Part | Stage 0 | Production (stage 2) | Same building block? |
| --- | --- | --- | --- |
| AWS account, network, region lock | The existing account, shared with another server; Sydney only | An account of its own; Sydney only | Partly: the network and the lock are the same, the account is not |
| Hostnames and TLS | Real hostnames, https | The same hostnames pattern | Yes; the certificate holder changes from Caddy to a load balancer |
| Production mode | `NODE_ENV=production`, all start-up rules on | The same | Yes |
| API | One copy, the production image | Two copies of the same image | Yes, but one copy |
| Portal and player bundles | Production builds | The same builds | Yes |
| Media worker | The production image, one copy | The same | Yes |
| Database | RDS PostgreSQL 17, one zone, smallest size | RDS PostgreSQL 17, two zones, larger | Yes; only size and failover differ |
| Database backups | Automatic, 7 days, restore to any minute | The same, plus copies in Melbourne | Yes, without Melbourne |
| Media storage | Disk first, then a private S3 bucket | Private S3 bucket | Yes from the second month |
| Sign-in | Cognito, MFA required | The same | Yes |
| Secrets | Parameter Store | The same | Yes |
| Deploy pipeline | GitHub Actions: build, migrate, release, health check | The same, releasing to staging first and then production | Yes |
| Job hand-off, API to worker | Shared folder on the one server | Redesigned for two servers | No |
| Logs and monitoring | Log files on the server | Central logs, metrics, paging | No |
| E-mail | Off | SES Sydney | No |
| Load balancer and firewall | None | Both | No |

What stage 0 teaches:

- running in production mode, with TLS, real hostnames and the proxy headers;
- building, releasing and rolling back through a pipeline, including migrations on a database
  that keeps its data;
- whether managed PostgreSQL accepts the three roles (unverified today), and how to work
  without a database superuser;
- restoring the database from a backup: one timed drill costs cents;
- Cognito sign-in, MFA and member provisioning;
- secrets handling, the region lock, and the AWS bill;
- S3 media storage, once the adapter is written;
- the Linux player against a real server.

What stage 0 does not teach, because the parts are absent:

- behaviour with two API copies, and failover;
- performance under load (that needs its own test, a stage 1 gate);
- monitoring and being paged;
- e-mail delivery;
- the load balancer and firewall.

### 3.4 Cost

| Item | USD a month | AUD a month |
| --- | ---: | ---: |
| EC2 `t4g.small` (2 vCPU, 2 GB), on demand, US$0.0212 an hour | 15.50 | 23.20 |
| Server disk, 40 GB gp3 | 3.90 | 5.90 |
| Public IPv4 address | 3.65 | 5.50 |
| Daily disk snapshots, 7 kept | 1.00 | 1.50 |
| RDS `db.t4g.micro`, one zone, US$0.025 an hour, with 20 GB of storage | 21.00 | 31.50 |
| Container registry (ECR), about 1 GB | 0.10 | 0.15 |
| DNS zone in Route 53 | 0.50 | 0.75 |
| S3 media, second month, a few GB | under 1 | under 1.50 |
| Cognito, Parameter Store, IAM, Organizations, Budgets, one CloudTrail trail, Let's Encrypt, the first 100 GB of outbound traffic | 0 | 0 |
| **Total** | **about 46** | **about 70** |

Two months is about A$140. TINNOX's AWS account already exists, so the new-customer credits
do not apply. If 2 GB of memory proves tight, the server can be resized to a `t4g.medium`
(4 GB) in a few minutes for A$23 more a month.

Not in the table: a domain name (about A$20 a year). GitHub costs nothing while the
repository is public (section 8).

Stage 0 runs in the existing account "Tinnox Production" (Michael, 25 Nov), which also runs
an unrelated server. The recommendation was a member account of its own: it keeps the CMS
apart from whatever else TINNOX runs and gives it its own bill, and it costs nothing. That
stays the recommendation for staging and production. In the shared account the CMS has its
own network, roles and key, and its resources carry the tag `project` = `tinnox-cms`.

The account was a _project_ of AWS's sign-up experience of September 2026: AWS managed the
organisation and its policies. On 25 November Michael activated "advanced features", which
cannot be undone. TINNOX now administers the organisation (management account, "Tinnox
Production" and an identity administration account that AWS added), and the organisation's
policies are TINNOX's to keep or change. As read that day:

- The region policy is attached to the whole organisation and allows Sydney only, plus the
  global services that answer from two US regions. Melbourne is refused until the policy
  names it. An organisation policy does not bind the management account, so nothing is
  built there.
- Identity providers are no longer forbidden, so GitHub can take a role with no stored key
  (item 6 below).
- New accounts are created as member accounts in AWS Organizations.

### 3.5 Work to build it

The money is small. The cost of stage 0 is engineering time: my estimate is two to three weeks
of focused work for the first month's list, and about a week for the S3 adapter.

First month:

1. AWS account baseline: the existing account "Tinnox Production" (section 3.4), a root
   password and MFA on the management account, the organisation's region policy kept as it
   is (Sydney only), a budget alert, CloudTrail.
2. An image for the API, running the TypeScript source on Node itself, as the media worker's
   image does (section 8.3), on the worker's pinned Node 24 (CI uses 22).
3. A compose file for the server, and the Caddy configuration.
4. A database bootstrap for RDS: the three roles without the `tinnox_test` database and
   without a superuser, passwords from Parameter Store. RDS accepts the `BYPASSRLS` role
   (tested 25 Nov on the stage 0 instance; see `infra/aws/README.md`, section 5).
5. Cognito: a Sydney user pool with TOTP required; confirm it sends `auth_time`, honours
   `prompt=login` and proves MFA through `acr` or `amr`; a Cognito reader for
   `scripts/lib/idp.ts`; a replacement for `verify:oidc`.
6. A deploy workflow in GitHub Actions: short-lived AWS credentials through OIDC (no stored
   keys), build and push images, then on the server stop the API, run migrations, start the
   API, check `/readyz`. Started by hand from `main` first; automatic on merge once trusted.
7. Secrets in Parameter Store. The migrator password is given to the migration step only; the
   API refuses to start if it sees it.
8. Create the first organisation and members with `provision-member`.
9. Point the Raspberry Pi at the real player hostname.

Second month:

10. An S3 implementation of the `ObjectStorage` interface in `packages/storage`, and the move
    of media to a private Sydney bucket.
11. One timed database restore drill.

### 3.6 Rules for stage 0

- Synthetic and internal data only. No customer data until the stage 1 gates pass.
- E-mail stays off. Production mode runs without it.
- The deploy workflow never runs for pull requests from forks and holds no long-lived keys.

## 4. What is needed now, and what waits

"Extra now" is the added monthly cost of doing a later item during stage 0.

| Item | Needed now? | Cost now | If deferred: when, and extra cost to do it now |
| --- | --- | --- | --- |
| Server, disk, IP address | Yes | A$35 | |
| Managed database (RDS, one zone) with automatic backups | Yes | A$32 | |
| TLS certificates | Yes | Free | |
| CI/CD and auto-deployment | Yes | Free while the repository is public (section 8) | |
| Cognito sign-in | Yes | Free | |
| Secrets store (Parameter Store) | Yes | Free | |
| Account baseline, region lock, budget alert | Yes | Free | |
| Daily disk snapshots | Yes | A$1.50 | |
| S3 media storage | Second month | Under A$1.50 | Needs the adapter written first |
| One database restore drill | Second month | Cents, once | |
| One outside uptime check (Better Stack or UptimeRobot free tier) | Optional | Free | |
| Server logs kept on the instance, rotated | Yes | Free | |
| Central logs and metrics (CloudWatch) | No | | Stage 1. Free under 5 GB a month, then about A$1 per GB |
| Paging (Better Stack paid) | No | | Stage 1. About A$45 |
| E-mail (SES Sydney) | No | | Stage 1. Under A$1; needs CMS-35 and CMS-27 first |
| Backup copies in Melbourne | No | | Stage 1. A few dollars |
| Threat detection (GuardDuty) | No | | Stage 1. About A$5 to A$10 |
| Load balancer | No | | Stage 2. Extra now: about A$35 |
| Web application firewall | No | | Stage 2. Extra now: about A$15 |
| Second API copy, database failover | No | | Stage 2. Extra now: about A$350 or more, and it needs code changes |
| Datadog or Grafana Cloud | No | | Stage 2, if CloudWatch is not enough |
| Support-access feature (reason and audit row per access) | No | | Stage 1. Engineering only |
| Penetration test | No | | Before the first external customer. One-off, typically A$8,000 to A$20,000 (my estimate, not a quote) |
| Privacy statement, breach plan, customer terms | No | | Before the first external customer. Lawyer's fee |

## 5. Stage 1 gates: before the first external customer

- Backup copies in Melbourne, and a restore drill from them.
- Central logs with a retention period, outside health checks, paging to a phone.
- E-mail through a reviewed Australian endpoint (CMS-35, CMS-27).
- The support-access feature (DEC-17).
- The 16-item pre-customer checklist in `docs/security/operations-and-release-checklist.md`,
  including the independent penetration test.
- Retention periods agreed and a purge path built for audit rows and departed customers.
- A load test at the 500-screen target and a 24-hour soak.
- The ruleset on `main` (CMS-26) and end-to-end tests as a required check.
- The repository private, on the GitHub Team plan (section 8).
- A compiled API image in place of `tsx` (section 8).
- The production hostnames on the product's own domain (section 8).

## 6. Stage 2 gates: before an uptime promise

- The job hand-off between API and worker redesigned so it does not need a shared folder.
- Rate limits shared between API copies, or the per-copy limits accepted in writing.
- The alert check moved off the in-process timer, or its lock proven with the chosen pooler.
- Two API copies in two zones behind a load balancer; database with automatic failover.
- Releases without a stop (expand-then-contract migrations), if daytime releases are needed.

## 7. The Poteto refactor

No conflict in substance. The refactor changes how application code is written; this plan adds
files that do not exist yet. The two meet in a few places:

| Where they meet | Poteto work | Deployment work | How to avoid a clash |
| --- | --- | --- | --- |
| `.github/workflows/` | Steps 36 and 37 add end-to-end workflows | A new deploy workflow | Separate files; do not edit `ci.yml` |
| `apps/api/src/config.ts` | Step 22 changes the loopback rule | New environment names for S3 (second month), the SMTP host list later | The first month needs no change here; the S3 names go in after group B merges |
| Job folder between API and worker | Step 22 adds a file-mode helper (CU-02), in progress | The server mounts this folder | Build the compose file after step 22 merges, or follow its modes |
| Sign-in code | Step 26 touches the callback's error handling | The Cognito reader is in `scripts/lib/idp.ts` | Different files; rebase whichever lands second |
| Migrations | Steps 22 and 31 and CMS-29 add migrations | The pipeline applies whatever is merged | No clash: this is the pipeline's job, and stage 0 data is disposable |
| Build id and reload notice | Step 44a | Useful after each deploy | Deployment does not depend on it |

Stage 0 does not have to wait for the refactor. Steps that add migrations or change the player
contract (22, 24, 31, 32, 38, 43, CMS-29) should land before stage 1, while there is no
customer data and no fielded player.

## 8. Open points, with a recommendation for each

### 8.1 Domain

A domain is required: production mode refuses plain http, a certificate needs a hostname, and
the session cookie is bound to it.

Decided (Michael, 25 Nov): the products use their own domain, `tinnox-one.com.au`, already
bought, and do not go under `tinnox.com.au`.

- Isolation: browsers treat every subdomain of `tinnox.com.au` as one site. A weakness in the
  company website, or in any other tool hosted under that name, would sit on the same site as
  the customer portal. A separate domain removes that exposure.
- Changing later is costly: a paired screen stores its credential under the player hostname,
  so moving the player to another hostname means pairing every screen again.

Layout, decided (Michael, 25 Nov):

| Hostname | Use |
| --- | --- |
| `app.test.tinnox-one.com.au`, `player.test.tinnox-one.com.au` | Stage 0, later the staging environment |
| `app.tinnox-one.com.au`, `player.tinnox-one.com.au` | Production |
| `tinnox-one.com.au`, `www.tinnox-one.com.au` | No application. A redirect to the company website for now, a product page later |

The portal does not go on the bare domain: a cookie or a script on the bare domain can reach
every subdomain, and the bare domain is where a product page belongs.

### 8.2 Repository visibility

Decided (Michael, 24 Nov): the repository stays public and on the Free plan through stage 0.
CI and the ruleset on `main` are free while it is public. It goes private on the GitHub Team
plan before the first external customer; the points below are the reasons and the cost then.

- The repository holds commercial product code, and it also publishes the threat model and
  the lists of open review findings.
- Everything pushed so far has already been public, and going private does not withdraw
  copies anyone has taken. The secret scan in CI has kept credentials out.
- Cost on the Free plan: private repositories include about 2,000 CI minutes a month. The
  repository used about 10 minutes a run over about 22 runs a day in the last five days, or
  roughly 6,500 minutes a month at that pace. The excess is about US$27 (A$40) a month.
- Cost on the Team plan: US$4 a seat a month for 4 seats, with about 3,000 minutes included;
  at the same pace about US$37 (A$55) a month in total. GitHub's plan page lists protected
  branches for private repositories under Team, so the ruleset on `main` (CMS-26) needs it.
- The pace above is an unusually busy week. Cancelling superseded runs and skipping CI for
  board-only commits would cut it.
- An approval step on deployments ("required reviewers") is not available for private
  repositories below GitHub Enterprise. The deploy workflow is started by hand from `main`
  instead, which gives the same control with one operator.

### 8.3 How the API image runs: `tsx` or a compiled build

The API is written in TypeScript, and Node runs JavaScript, so the code has to be converted.
There are two ways:

- `tsx` converts it in memory each time the API starts. This is how the API runs today in
  development and in every test. It needs no build step, but it puts a development tool and
  all development dependencies into the production image, and start-up takes a few seconds
  longer.
- A compiled build converts it once, in CI, and the image holds only JavaScript and the
  production dependencies. The image is smaller, starts faster and has less in it to attack.
  It needs a build set up for the monorepo's shared packages, which does not exist yet.

Decided (Michael, 25 Nov): no compiled build for stage 0; a compiled build before stage 1.

As built (25 Nov): the stage 0 image needs neither. Node 24 runs the TypeScript source
directly by removing the types as it loads each file, which the repository's settings allow
and the media worker's image already does. So the image holds production dependencies only
and no development tool. What remains for stage 1: CI tests the API through `tsx` on Node 22,
so either CI tests the image as it is built, or the compiled build replaces it.

### 8.4 Settled

- The AWS account exists and has an organisation; people sign in through Google (Michael,
  24 Nov).
