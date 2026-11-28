# Yodeck gap analysis

Date: 2026-11-28. Status: DIRECTLY OBSERVED (read-only) plus documentation.

This report compares Yodeck with TINNOX CMS and lists what TINNOX does not do yet. It follows `yodeck-workflow-audit.md` (documentation audit, 2026-11-03) and `yodeck-ui-observation.md` (first signed-in walkthrough, 2026-11-15).

## 1. How it was gathered

- **Yodeck, observed.** The Yodeck portal was walked through read-only in the user's signed-in Chrome on 2026-11-28. Nothing was saved, pushed, uploaded, paired, invited or bought.
- **Yodeck, documented.** Yodeck's public pricing page, feature list, help centre, user manual, release notes and API specification (section 8).
- **TINNOX.** Read from the code and docs on branch main as of 2026-11-28 (commit `d67d915`; see section 7 for the one later merge). Nothing was run.
- **Verification.** Every gap row was checked by an independent verifier against the code. Rows the verifier dropped are not in the tables (section 7 lists them).

Account-specific values (names, e-mails, IDs, screen and content names) are left out on purpose. TINNOX wording is used throughout: "screen", not "display" (P2-03).

### The "Unlimited" edition

- **The account is in Yodeck's "Unlimited" trial** (DIRECTLY OBSERVED). A banner at the top of the portal on 28 Nov said the account has free access to every feature for up to 5 screens, with 5 days left; after that it keeps 1 screen with basic features unless it upgrades. The settings page shows the plan as **Free plan, 5 screen licences**.
- **Yodeck sells no plan called Unlimited.** Its plans are Free, Basic, Premium, Enterprise and Enterprise+.
- **"Unlimited Access Period" is a trial, not a plan.** New sign-ups since 2 March 2026 get 30 days, up to 5 screens, all features and apps. Yodeck's manual and one help article say it runs on the Enterprise plan; an older help article says Basic, Premium or Enterprise. At day 30 the account upgrades or drops to Free with 1 screen; with no choice, it pauses with a quota of 1, and features outside the chosen plan are switched off.
- The word also appears in the top tier of the Embeddable Feeds add-on and in "unlimited" storage, bandwidth and users on every plan (storage and bandwidth under fair use).
- **So what was seen is roughly Yodeck's Enterprise feature set**, not what a Free account keeps after the trial. The comparison below is against that full set. The trial ends about 3 December 2026; a repeat walkthrough after that date would see the Free plan only.

Yodeck's published plans on 28 Nov 2026 ([pricing page](https://www.yodeck.com/pricing/)):

| Plan | Price per screen per month | Notable additions |
|---|---|---|
| Free | USD 0, one screen only | All Basic features |
| Basic | USD 8 (AU$13) | All media types, templates, about 90 apps, the interactive kiosk app, basic scheduling |
| Premium | USD 12 (AU$18.50) | API and AI agent, proof of play, tag-based and nested playlists, weekly media slots, volume schedules, layout locks, about 147 apps |
| Enterprise | USD 16 (AU$25) | Workspaces, SAML SSO and SCIM, custom roles, audit logs, security policies, player encryption, Content Flows, branded templates, billing entities |
| Enterprise+ | Quote, at least 25 screens | Account manager, priority support, design and security-assessment services, hardware cover included |

What this means for the evidence:

- Most features with a Premium or Enterprise badge opened normally. They are labelled **Observed (plan-gated)**.
- Enterprise+ services (account manager, 24/7 support, security assessment, bundled hardware cover) are not part of the trial and were not seen.
- **Seen only as a locked control:** Embeddable Feeds, the paid content add-ons, Billing Entities and the add-ons page, the social-login controls, and the custom boot logo (unlocked by leaving a rating).
- **Docs only** (not found or not reachable in the portal), among others: the emergency broadcast control and what an alert can show, takeover precedence, Content Flows targeting, player runtime and update behaviour, pre-provisioning, the REST API, webhooks, the AI agent, the SLA, sub-processors, certifications, partner sign-in, audit retention, the installable portal app, scale performance and the storage allowance.

## 2. Labels

Yodeck evidence:

| Label | Meaning |
|---|---|
| Observed | Seen in the signed-in portal on 2026-11-28. Where a control was read from page markup and not used, the row says so. |
| Observed (plan-gated: plan) | Seen in the portal behind a plan badge. Usable because of the trial unless the row says it was locked. |
| Docs only | Not seen in the portal. Taken from Yodeck's public documentation. |

TINNOX status:

| Status | Meaning |
|---|---|
| Parity | The same job is done today, sometimes in a different way. |
| Partial | Part of it is built. The row says what is missing. |
| Planned | Not built. A decision, backlog story, status card or stage document plans it. |
| Missing | Not built, and no plan names it. |
| Out of scope (by decision) | Deliberately excluded by a recorded decision. Listed in section 5, not in the area tables. |

Priority: **High** blocks a first installation, a release-1 scenario or a stage 1 gate. **Medium** is expected soon after launch. **Low** is a convenience, niche or later need. **n/a** for parity and out-of-scope rows.

"Built" means built and tested in development. Production is not deployed yet (CMS-37), and production sends no alert e-mail until the provider review (CMS-35).

## 3. Summary

### 3.1 Counts

By TINNOX status (363 capabilities):

| Status | Rows |
|---|---|
| Parity | 71 |
| Partial | 89 |
| Planned | 65 |
| Missing | 95 |
| Out of scope (by decision) | 43 |
| **Total** | **363** |

By priority (the 249 gaps: Partial, Planned and Missing):

| Priority | Rows |
|---|---|
| High | 18 |
| Medium | 64 |
| Low | 167 |

By area:

| Area | Rows | Parity | Partial | Planned | Missing | Out of scope | High | Medium | Low |
|---|---|---|---|---|---|---|---|---|---|
| Shell and dashboard | 31 | 13 | 7 | 1 | 7 | 3 | 0 | 1 | 14 |
| Media | 51 | 13 | 16 | 6 | 10 | 6 | 2 | 10 | 20 |
| Apps | 52 | 1 | 13 | 15 | 9 | 14 | 0 | 5 | 32 |
| Playlists | 37 | 11 | 10 | 1 | 13 | 2 | 1 | 5 | 18 |
| Layouts | 39 | 3 | 12 | 4 | 18 | 2 | 1 | 9 | 24 |
| Schedules and alerts | 41 | 7 | 7 | 15 | 11 | 1 | 4 | 9 | 20 |
| Screens and players | 64 | 17 | 17 | 9 | 18 | 3 | 6 | 15 | 23 |
| Account, users and security | 48 | 6 | 7 | 14 | 9 | 12 | 4 | 10 | 16 |

The verifiers passed 404 rows (315 confirmed, 89 corrected) and dropped 21. Forty-one passed rows described the same capability as another row and were folded into it, which gives 363. Section 7 lists the folds and where verifiers disagreed.

### 3.2 The most important gaps

| # | Capability | Why it matters | TINNOX status | Suggested next step |
|---|---|---|---|---|
| 1 | Kiosk-grade player runtime | Installed signs must survive power cuts and crashes with nobody on site. On the Pi 5, a power cut wiped the player in 2 of 5 cuts. | Planned (CMS-42, Epic F) | Build the native CM5 player (F1, F2) before the first installation. |
| 2 | Remote player commands | A page reload is the only way a player moves to a new manifest version. Every site visit costs SLA margin. | Planned (CMS-38, F5) | Add a command channel, starting with reload and restart. |
| 3 | Automatic player updates | Today every player release needs someone at each screen. | Partial (F6) | Signed updates with a maintenance window and rollback. |
| 4 | Screenshots | Staff need to see what a screen shows without a site visit (scenario 4). | Planned (CMS-38, G2) | On-demand screenshots, delivered with the command channel. |
| 5 | Player telemetry in the portal | Heat, full storage and network faults in outdoor cabinets must be diagnosed remotely. | Partial (F2, G5) | Show build, storage and temperature on the screen page. |
| 6 | Emergency messages and takeover | A school or council sign must show a notice within minutes, then return to normal (E2E-01). | Planned (CMS-14) | Specify CMS-14: message, template, target screens, duration, return. |
| 7 | Proof of play | Councils need a report of what played over a period (E2E-03). | Planned (CMS-16, G6) | Log plays per item on the player; add a date-range CSV. |
| 8 | Dated and one-off schedule events | Campaign end dates and school terms are release-1 uses. | Planned (D3) | Add date ranges and one-off events in the next manifest version. |
| 9 | PDF documents | Notices often arrive as PDFs. DEC-24 puts PDF in release 1 (proposed). | Planned (CMS-17) | Rasterise PDF pages in the isolated worker. |
| 10 | Wider video input | Phone footage (HEVC in MOV) and agency files are refused, and office staff cannot transcode. | Partial (spec 6.2 adds only HEVC in MP4; C3 renditions serve players) | Decide which inputs to transcode, then add it to the worker. |
| 11 | Free zone sizes in layouts | Header, side and split layouts are a typical first request. The rest of the stack already accepts them. | Planned (stage B client question 1) | Add numeric zone fields to the layout editor. |
| 12 | Customer-approved staff support access | Scenario 4 and the SLA need staff inside an account, with consent. A stage 1 gate. | Planned (H1, DEC-17) | Build the B+ support grants. |
| 13 | Customer off-boarding | A purge path is a stage 1 gate. Council and school contracts require deletion at exit. | Planned (H3) | A staff-run, audited deletion with a report. |
| 14 | Self-service password and MFA reset | Every forgotten password or lost phone becomes a TINNOX ticket. | Planned (A3) | Turn on self-service recovery once the e-mail provider is reviewed. |
| 15 | Sub-processor and data-location statement | Councils, schools and state bodies assess it before buying. Required before the first external customer. | Partial (checklist items 2, 4) | Publish the privacy statement; update the internal inventory. |

### 3.3 The overall picture

TINNOX matches Yodeck on the everyday loop of library, playlists and push, and goes further on push validation, honest status, audit and tenant isolation. The largest gaps sit around the player and day-two operations: no kiosk-grade runtime, no remote commands, screenshots or telemetry, and updates that need someone at the screen. The second cluster is release-1 promises not built yet: emergency messages and takeover, dated schedule events, proof of play and PDF. Layouts and apps are deliberately narrow (one layout preset, six built-in apps), and most of Yodeck's connectors, AI and interactive kiosks are out of scope by decision. Several launch gates have no Yodeck counterpart to copy but must close before the first external customer: support access, off-boarding, a privacy and sub-processor statement, and self-service password reset.

## 4. Areas

Each table orders rows High, Medium, Low, then Parity. Out-of-scope rows are in section 5. "Also covers" in Notes names a row from another area that was folded in.

### 4.1 Shell and dashboard

| Capability | Yodeck | Evidence | TINNOX | Priority | Notes |
|---|---|---|---|---|---|
| Help and support link | A help menu at the foot of the sidebar links to the online manual. | Observed | **Missing.** No help, documentation or support link. Two messages say "contact TINNOX support" with nowhere to go. `apps/portal/src/shell/nav.ts:103-105` | Medium | Operators are office staff, not signage experts. J2 plans documentation, not a portal link. Also covers the account help-hub row. |
| User menu | Profile, account settings, upgrade, buy players, users, audit log, sign out. | Observed | **Partial.** Name and role, then Settings, Users, Audit log, Sign out. No profile entry. `apps/portal/src/shell/AccountMenu.tsx:63-88` | Low | Missing entries are rated in their own rows. |
| Guided product tours | Tours for screens, media, playlists, schedules and the layout editor; "Start Tour" on the empty dashboard. | Observed | **Partial.** A "Get set up" checklist of four real steps, hidden once done. No step-by-step tours. `apps/portal/src/features/dashboard/SetupCard.tsx:10-55` | Low | The checklist already guides first use. Also covers the playlist and layout-editor tour rows. |
| Plan card on the dashboard | Plan name, screen-licence limit, manage link. | Observed | **Partial.** The Library card shows storage used against the quota. No plan, seats or term (N1 to N3). `apps/portal/src/features/dashboard/LibraryCard.tsx:33-60` | Low | Useful once entitlements exist. Hardware comes with 12 months included (DEC-25). |
| Installable portal app | Installs as a web app on phone, tablet or desktop (release notes, September 2026). | Docs only | **Partial.** Responsive and works in a phone browser. No web app manifest. `apps/portal/index.html` | Low | A service worker would need a CSP change (`worker-src 'none'`). |
| Theme choice | Light, Dark or System per user. | Observed | **Partial.** Follows the system setting, contrast-checked. No override; it would need a server-side member setting. `apps/portal/src/styles/tokens.css:162` | Low | Dark mode already works for anyone whose system uses it. |
| Personal time zone | A picker of about 550 zones. | Observed | **Partial.** Times show in the browser's zone, named. Schedules use each screen's site zone. `apps/portal/src/lib/format.ts:49-64` | Low | An override only helps someone viewing from another zone. |
| Personal alert toggles | E-mail when any screen goes offline or comes back. | Observed | **Partial.** One organisation list of up to 20 confirmed addresses. No self-subscribe: no member e-mail is stored. `apps/api/src/routes/alert-recipients.ts:83` | Low | Production sends no alert e-mail until CMS-35. Also covers the account notification row. |
| Dashboard and screens list at scale | Release notes: these pages load up to 6x faster for 200+ screens. | Docs only | **Planned.** Counts are made per request and the list loads whole. A 500-screen load test is a stage 1 gate. `apps/api/src/routes/overview.ts:25` | Low | Target: 500-screen dashboard under 3 s (`docs/tinnox-mvp-spec.md:387`). |
| Learning resources | Forum, video academy, intro video, "book a live demo" link. | Observed | **Missing.** None. An embedded YouTube frame would break D18; video would need self-hosting in Australia. `docs/prototype-m0.md:34` | Low | Yodeck's demo link puts the user's name and e-mail in the URL. |
| Profile page | Tabs for basic info, notifications, password, two-factor, theme, connected apps. | Observed | **Missing.** No profile route or menu entry. `apps/portal/src/shell/nav.ts:108-120` | Low | Worth adding once personal preferences exist. Also covers the account personal-profile row. |
| Interface language | 17 languages. | Observed | **Missing.** Australian English only. Release 1 serves Australia only (DEC-03). `apps/portal/index.html:2` | Low | New Zealand would need no new language. |
| Date format, clock and first day of week | Date format, 12 or 24 hour, Monday or Sunday. | Observed | **Missing.** Fixed en-AU formats and Monday-first weeks. `apps/portal/src/lib/format.ts:49-57` | Low | The fixed formats match Australian conventions. |
| Newsletter consent | Opt-in for feature announcements. | Observed | **Missing.** The CMS sends no marketing e-mail. | Low | Needed only if TINNOX sends product news from the CMS, with Spam Act consent records. |
| New-location sign-in alert | E-mail when someone signs in from a new location or address. | Observed | **Missing.** Sign-ins are audited and MFA is required. The Cognito pool is on the Essentials tier; threat protection is off. `infra/aws/identity.yml:68` | Low | Threat protection appears to need a higher tier (unverified pending a pricing check). |
| Sidebar with a Media group | One entry per section; Media opens into six type views. | Observed | **Parity.** Same order. Audio, Documents and Web pages carry a Planned pill. Welcome is folded into the dashboard. `apps/portal/src/shell/nav.ts:57-101` | n/a | Built to P2-01. |
| Sidebar collapse | Collapses to icons; not remembered. | Observed | **Parity.** Icons with tooltips; kept for the page session only (no web storage). `apps/portal/src/shell/Sidebar.tsx:320` | n/a | |
| Narrow-screen navigation | A hidden menu button (markup only). | Observed | **Parity.** A drawer under 900 px, with focus moved to the page after a choice. `apps/portal/src/shell/AppShell.tsx:88-97` | n/a | |
| Breadcrumb | "Home / page" on nested pages. | Observed | **Parity.** Breadcrumb on Settings sub-pages; a back link on editors. `apps/portal/src/shell/PageHeader.tsx:63` | n/a | |
| Push to Screens button | A primary button on every page. | Observed | **Parity.** On every list, dashboard and settings page, with a waiting count. Editors offer a scoped push. Roles without push see a chip. `apps/portal/src/shell/PushButton.tsx:18-50` | n/a | Also covers the playlists header-button row. |
| Push confirmation | One confirmation for all screens; no list, choice or result. | Observed | **Parity.** Goes further: grouped list, search and ticks, blocked reasons, a result per screen, safe retries. `apps/portal/src/features/push/README.md:44-57` | n/a | |
| Pending-changes prompt | A toast with a push link. | Observed | **Parity.** Count badge, a dashboard "Changes waiting" card, push offers after assigning. `apps/portal/src/features/dashboard/PushCard.tsx:28-46` | n/a | |
| Welcome page | Starter cards on a landing page. | Observed | **Parity.** Folded into the dashboard's "Get set up" checklist by decision. `docs/portal-v2/README.md:34` | n/a | |
| Welcome: start a playlist | A card opens a new playlist. | Observed | **Parity.** A checklist step links to Playlists and its New playlist dialog. `apps/portal/src/lib/dashboard.ts:294-299` | n/a | |
| Screen counters on the dashboard | Online, Offline, Registered, Unregistered, each linked to the list. | Observed | **Parity.** In sync, Updating or waiting, Needs attention, Not paired; each opens the filtered list. Never "online" (P2-04). `apps/portal/src/lib/dashboard.ts:144-158` | n/a | Also covers the screens counter row. |
| Dashboard empty state | Explains the widget; offers a tour and Add Screen. | Observed | **Parity.** Role-aware empty text; Add screen in the checklist. `apps/portal/src/features/dashboard/ScreensCard.tsx:52-57` | n/a | |
| Dashboard by role | A "no permission" variant per widget. | Observed | **Parity.** Each widget adapts to the role's permission keys. `apps/portal/src/features/dashboard/DashboardPage.tsx:123-124` | n/a | |
| Recent activity | About six recent events; no link to the full log. | Observed | **Parity.** The last 10 events with a link to the audit log; filtered for roles without `audit.read`. `apps/portal/src/features/dashboard/ActivityCard.tsx:44-78` | n/a | |

TINNOX ahead:

- **Selective, checked push.** Screens are grouped as waiting, blocked, up to date or empty; blocked ones name each reason. Yodeck pushes to all with one confirmation.
- **Scoped push.** "Push to this screen", "Push now" in the playlist editor, and a push offer after assigning content.
- **Role-aware push.** Roles without `push.publish` see a waiting count, never the push dialog.
- **Honest status.** Counters report what players last said, and screens needing attention are listed by name.
- **Data-driven setup checklist** that tracks four real steps and disappears when done.
- **Live dashboard** that re-reads every 15 s while visible and keeps the last figures if a refresh fails.
- **Changes waiting and Library cards**: screens waiting or blocked with a "Review and push" action, storage against the quota on a meter, and files still processing or failed.
- **Activity linked to an audit log every customer gets.** Yodeck's customer audit log is Enterprise-only (help centre).
- **No trackers, chat widgets or personal data in URLs** (strict CSP, D18).
- **Accessible shell**: skip link, announced page names, and automated axe checks against WCAG 2.2 A and AA rules (failing on serious or critical issues) in both themes.

### 4.2 Media

| Capability | Yodeck | Evidence | TINNOX | Priority | Notes |
|---|---|---|---|---|---|
| Video formats and re-encoding | Accepts most containers and re-encodes to H.264 with AAC. A counter shows encoding tasks. | Observed | **Partial.** Video upload works, but nothing is transcoded: MP4 with one 8-bit H.264 stream, up to 4K and 10 min. HEVC, MOV and WebM are refused with a named reason. `apps/media-worker/src/video.ts:84-106` | High | Phone footage and agency MOV or ProRes are refused. Planned renditions (C3, DEC-22) serve players, not more inputs. |
| PDF documents | PDF as a slideshow with a default page time, per-page exceptions and skip. | Observed | **Planned.** Release 1 by DEC-24, one image per page (CMS-17). Sidebar and Add media tab say Planned. Page timing not specified. `docs/decisions-2026-11.md:39` | High | School and council notices often arrive as PDFs. |
| Expired filter | Filters the list to expired or non-expired items. | Observed | **Missing.** Items can have a window, but there is no expired badge, filter or clean-up. `apps/portal/src/features/media/library/MediaLibrary.tsx:114-116` | Medium | Retail campaigns leave expired files behind. Screens are unaffected: the player hides them. |
| Bulk edit | Bulk tags, default duration, availability, weekly slots, web-page fallback. | Observed | **Partial.** Tags can be added and removed in bulk. Duration and availability are set one file at a time. `apps/portal/src/lib/tagColours.ts:190-226` | Medium | Giving a batch of campaign files one end date is routine for multi-site retailers. |
| Local upload | Drop zone and file browser, up to 100 files per import. | Observed | **Partial.** Several files with progress and a verdict per file, sent one at a time with no resume. Leaving the library cancels waiting uploads. Resumable upload is C1. `apps/portal/src/features/media/library/useUploadQueue.ts:45` | Medium | Large LED video on a slow site link starts over after any interruption. |
| Image formats | JPEG, PNG, BMP, GIF, WebP, SVG, HEIC; up to 50 MP. | Observed | **Partial.** JPEG and PNG only, up to 40 MP and 8192 px per side. The spec plans WebP and 50 MP; GIF, SVG and HEIC are not planned. `packages/contracts/src/media.ts:23-32` | Medium | A refusal sends office staff back to a designer. |
| Upload size limits | 100 files per import; 5 GB per file (help centre). | Observed | **Partial.** 200 MB per file and 10 min per video by default; configurable up to 2 GB. `packages/contracts/src/limits.ts:47-58` | Medium | Raising it is configuration, but files near 2 GB also need resumable upload. |
| Storage allowance | Unlimited storage and bandwidth on every plan, under fair use. | Docs only | **Partial.** 5 GB per organisation by default, enforced under a lock, with a meter and warnings. Quotas per display by plan are designed (N3). `packages/contracts/src/limits.ts:58` | Medium | A flat 5 GB looks tight for a 20-screen retailer. |
| PowerPoint | PPT or PPTX converted to video, keeping animations. | Observed | **Planned.** Release 2 by DEC-24, on TINNOX-player routes only. `docs/decisions-2026-11.md:39` | Medium | Schools and councils keep many notices in PowerPoint. |
| Web page item | A URL with preview, zoom, refresh interval and fallback image. | Observed | **Planned.** CMS-18, after the P2-06 review: sandboxed, off by default; release 2 by DEC-24. Zoom, refresh and fallback not specified. `docs/portal-v2/README.md:16` | Medium | Common on indoor screens; rare on outdoor LED at launch. |
| Replace a file, keep where it is used | "Change" on the source keeps every reference. | Observed | **Planned.** A new version means a new upload and editing each playlist (C4). `docs/implementation-backlog.md:54` | Medium | Swapping this week's notice or menu is a weekly task. |
| Weekly availability slots | Rows of times, dates and weekdays per item. | Observed (plan-gated: Premium) | **Planned.** One from-until window per item. Weekly slots per playlist item are in spec 6.4 and D1. `docs/tinnox-mvp-spec.md:123` | Medium | Breakfast menus and school-hours notices. Also covers the playlists item-availability row. |
| Sections by type | All, Images, Videos, Audio, Documents, Web Pages. | Observed | **Partial.** All, Images and Videos built; the others are marked Planned. `apps/portal/src/shell/nav.ts:66-91` | Low | The missing types are rated in their own rows. |
| Folders | Folders that can nest. | Observed | **Partial.** Flat, one level: create, rename, delete. The spec plans nesting. `apps/api/src/routes/folders.ts:1-4` | Low | Flat folders and tags cover pilot-size libraries. |
| Move to folder | Per item and in bulk; drag onto folders (docs). | Observed | **Partial.** Row menu and bulk; no drag onto a folder. `apps/portal/src/features/shared/MoveToFolderDialog.tsx` | Low | Drag only saves a step. |
| Page size and paging | 5 to 100 per page, or All. | Observed | **Partial.** 10 to 100 per page, in the browser; the whole library is loaded. `apps/portal/src/lib/listView.ts:19-20` | Low | Server paging matters only at thousands of files. |
| Who created and changed an item | Created by, modified by, link to the log. | Observed | **Partial.** Upload time only. The audit log names actors but has no object filter or link. `apps/portal/src/features/media/detail/MediaDetailsCard.tsx:116-118` | Low | The audit log already answers who. |
| Add to playlist from media | Several playlists at once; row menu, bulk and editor. | Observed | **Partial.** One file to one playlist. The append has no version check, so a parallel edit can be lost. `apps/portal/src/features/media/library/AddToPlaylist.tsx:21-60` | Low | The lost-edit risk (open in `docs/portal-v2/stage-a.md:227`) matters more than bulk add. |
| Duplicate media | Per item and in bulk. | Observed | **Missing.** `apps/portal/src/features/media/library/MediaRowMenu.tsx:41-87` | Low | Mostly gives a file a second window; per-item windows (spec 6.4) remove the need. |
| Bulk actions | Edit, add to playlist, set to screen, duplicate, move, delete. | Observed | **Partial.** Move, add or remove tags, delete; one request per item. `apps/portal/src/features/media/library/MediaLibrary.tsx:762-810` | Low | The common bulk tasks exist. |
| 4K video option | An account switch to encode 4K as well as 1080p. | Observed | **Partial.** 4K is accepted and played as uploaded. No lower rendition is made (C3). `packages/contracts/src/limits.ts:51-52` | Low | Most TINNOX LED canvases are below 1080p. |
| Import from URL | Copies a file from one or more links. | Observed | **Missing.** No plan. A server-side fetch needs its own request-forgery review. | Low | Download and upload again works. |
| Word and Excel | Converted to PDF slideshows. | Observed | **Missing.** Only PDF and PowerPoint are planned. `docs/decisions-2026-11.md:39` | Low | Saving as PDF works once PDF lands. |
| Audio | Audio files, links and streams; video plays with sound. | Observed | **Planned.** CMS-17, but the spec keeps audio out of release 1. Screens play muted. `packages/contracts/src/manifest.ts:60` | Low | Outdoor LED and most kiosks are silent. |
| Web page scripting | Script editor, recorder, cookie-banner script, form log-in. | Observed | **Missing.** Conflicts with the sandbox P2-06 requires, and would store third-party log-ins. | Low | Only relevant once web pages exist. |
| Web page engine options | Engine choice, session retention, Flash, ignore certificate errors, user agent. | Observed | **Missing.** No web page item. The player's CSP limits connections to the API. `apps/player-web/index.html:11` | Low | Do not copy Flash or ignoring certificate errors. |
| Media tags page | One tag list shared by media and apps, with bulk actions. | Observed | **Partial.** Rename, recolour and delete with usage counts. No app tags, no bulk tag actions. `apps/portal/src/features/settings/TagsPage.tsx` | Low | App tags are rated in the apps area. |
| Image editor | A full-screen editor: crop, resize, filters, text, shapes, layers. | Observed | **Missing.** No plan. Cover fit crops to each canvas at play time. `packages/contracts/src/canvas.ts:4-6` | Low | Also covers the layouts image-editor row. |
| Video rotate and crop | Rotate by quarter turns and crop by percentage at playback. | Observed | **Missing.** TINNOX rotates whole screens. | Low | Per-video crop mostly serves video walls, which are out of scope. |
| Video subtitles | A subtitles switch (hidden, not tried). | Observed | **Missing.** | Low | The Yodeck switch was never exercised. Captions may matter to councils later. |
| Sample media | A new library starts with sample images and video. | Observed | **Missing.** A new library is empty; the checklist guides first use. | Low | TINNOX provisions its customers and can help with first content. |
| Video thumbnails | Each video has a thumbnail. | Observed | **Partial.** No poster frame on the server (C3). The portal draws the first frame in the browser. `apps/portal/src/features/shared/MediaThumb.tsx:28-32` | Low | A server poster frame would save bandwidth. |
| Grid and list views | Grid by default, or a list with columns. | Observed | **Parity.** Table by default, or a grid. Size and Status are extra columns. `apps/portal/src/features/media/library/MediaLibrary.tsx:316-378` | n/a | |
| Column sorting | Name, type and modified. | Observed | **Parity.** Name, modified and size; kind is covered by the type views. `apps/portal/src/lib/mediaLibraryQuery.ts:227-234` | n/a | |
| Text search | By name, written to the URL. | Observed | **Parity.** Display name and original file name, written to the URL. Runs in the browser. `apps/portal/src/lib/mediaLibraryList.ts:77-79` | n/a | |
| Search by tags | A tag-search dialog. | Observed | **Parity.** A multi-tag filter combined with the other filters, kept in the URL. `apps/portal/src/features/shared/TagFilter.tsx` | n/a | |
| Reload | A reload button. | Observed | **Parity.** Refresh, plus a re-read every 2 s while anything is processing. `apps/portal/src/features/media/library/MediaLibrary.tsx:629-634` | n/a | |
| Delete media | Row, bulk and editor. | Observed | **Parity.** Refused while a live playlist uses the file, naming up to five. Bytes are kept while a past push refers to them. `apps/api/src/routes/media.ts:523-611` | n/a | |
| Play as uploaded | A "skip encoding" switch for advanced users. | Observed | **Parity.** Every accepted file plays exactly as uploaded today. `apps/media-worker/src/inspect.ts:1-7` | n/a | Keep an as-is choice for pixel-exact LED content once renditions arrive. |
| Details panel | Preview, ID, upload date, resolution. | Observed | **Parity.** Preview plus name, kind, size, length, codec, upload time, SHA-256 and ID. `apps/portal/src/features/media/detail/MediaDetailsCard.tsx:83-134` | n/a | |
| Where used | A "used by" dialog. | Observed | **Parity.** Live playlists, and screens whose current push holds the file. `apps/api/src/routes/media.ts:433-471` | n/a | |
| Name and description | Unique name up to 80 characters; optional description. | Observed | **Parity.** Optional display name (120) and description (500); names need not be unique. `packages/contracts/src/limits.ts:110-112` | n/a | |
| Default duration | A stepper; 5 s for images. | Observed | **Parity.** 1 s to 1 h for images, 10 s fallback; refused for video. `apps/api/src/routes/media.ts:347-375` | n/a | |
| Tags on each item | A tag field with a link to manage tags. | Observed | **Parity.** Eight colours, up to 50 tags per item, created from the picker. `apps/api/src/routes/tags.ts:77-212` | n/a | |
| Availability window | From and to, or non-expiring. | Observed | **Parity.** From and until in each screen's site zone, enforced by the player offline. `apps/player-web/src/core/time-rules.ts:69-92` | n/a | |

TINNOX ahead:

- **Named rejection reasons.** The file type is decided from content, and a refused file shows one of 14 named reasons on its row.
- **Quarantine and an isolated worker.** Files stay unusable until accepted. The worker has no network, a read-only filesystem and no capabilities, and the API re-checks its verdict.
- **Where used also lists screens**, not only the playlists that refer to a file.
- **A delete never breaks a screen.** Refused while in use, with a database guard; bytes kept for earlier pushes.
- **Full technical facts** on the detail page, and members can view the original file.
- **Every filter in the URL**, so a filtered view can be reloaded or shared.
- **Processing status filter** with live refresh.
- **Audit trail for every customer and role**, written in the same transaction as each change. Yodeck's customer audit log is Enterprise-only.
- **Coloured tags with usage counts.**
- **Per-screen pixel canvas** instead of account-wide ratios, which suits non-16:9 LED sizes.
- **Media stays in Australia** (DEC-13). Yodeck stores media in AWS Ireland and offers no Australian region.

### 4.3 Apps

| Capability | Yodeck | Evidence | TINNOX | Priority | Notes |
|---|---|---|---|---|---|
| Rich text | A full text editor: fonts, sizes, styles, lists, alignment, images, links, tables. | Observed | **Partial.** The Text app has a heading (60 characters) and a message (280), sized to fit, in two colours. No formatting. `packages/contracts/src/app.ts:75-86` | Medium | Notices are the core scenario. Operators expect size, alignment and bold; spec 6.5 asks for a band font size. |
| App styling | Theme presets, colours with transparency, 39 fonts including custom ones, size, weight, background image. | Observed | **Partial.** One text and one background colour, with a contrast warning. System fonts only. Band font size deferred. `packages/contracts/src/app.ts:23-26` | Medium | System-font text looks generic on a large LED wall. |
| App availability window | From and to, weekly slots, and an expired filter on the list. | Observed | **Planned.** Deferred in stage B; the player always plays apps. A schedule's weekly events can limit the whole playlist. `docs/portal-v2/stage-b.md:799` | Medium | Time-limited Text, Ticker or Countdown notices must be removed by hand and pushed again today. |
| Current weather | Player location or a map pick, units, 39 languages, themes; data from a weather service. | Observed | **Planned.** CMS-3, after the P2-06 review. Sites store no location. `docs/tinnox-mvp-spec.md:245` | Medium | Common on outdoor signs. The data source needs a check against DEC-13. |
| Embed app | Paste embed code from any service. | Observed | **Planned.** P2-06 allows embedded pages only after a review, sandboxed and off by default. CMS-18 covers web pages. `docs/portal-v2/README.md:16` | Medium | The usual way out when a customer asks for an unsupported source. |
| Apps list | Thumbnails, tags, sorting, paging, grid view. | Observed | **Partial.** Name, Type, Used in, Updated; sort, count, refresh. No preview thumbnails, tags, grid, selection or paging. `apps/portal/src/features/apps/AppsPage.tsx:85-131` | Low | Add grid and paging past about 100 apps. |
| Tags on apps | A tag field, tag column and tag search. | Observed | **Planned.** Deferred in stage B. Media and screens have tags. `docs/portal-v2/stage-b.md:799` | Low | Search and the type filter are enough at first. |
| Folders for apps | Add folder and Move. | Observed | **Planned.** Deferred in stage B. Media has flat folders. `docs/portal-v2/stage-b.md:799` | Low | |
| App row menu | Edit, add to playlist, set to screen, duplicate, move, details, delete. | Observed | **Partial.** Edit and Delete. Apps are added from the playlist editor. Duplicate is deferred. `apps/portal/src/features/apps/AppsPage.tsx:134-160` | Low | |
| Bulk actions on apps | Add to playlist, set to screen, duplicate, move, delete. | Observed | **Planned.** Deferred with grid and paging. `docs/portal-v2/stage-b.md:801` | Low | |
| Who created and changed an app | Created by, modified by, link to the log. | Observed | **Partial.** Created and updated times, not who. The audit log names actors; no link or object filter. `apps/portal/src/features/apps/AppEditor.tsx:606-615` | Low | |
| Where an app is used | A "used by" dialog grouped by container. | Observed | **Partial.** "Used in N playlists". Names appear only when a delete is refused. `apps/api/src/routes/apps.ts:164-177` | Low | The media where-used view is a ready pattern. |
| App gallery | About 147 entries in 11 categories, search, shortcuts into other sections. | Observed | **Partial.** A create dialog with six types. The spec keeps an app catalogue out of release 1. `apps/portal/src/features/apps/CreateAppDialog.tsx:17-22` | Low | A gallery pays off only once outside-data apps exist. |
| Player support per app | Each app lists the players that can run it. | Observed | **Planned.** Pushes are checked against route profiles, but apps are not in them yet (deferred). `packages/domain/src/capability.ts:29-66` | Low | Must land before the Huidu route ships: those cards cannot run the app renderer. |
| Plan-gated apps | 16 apps marked Premium. | Observed (plan-gated: Premium) | **Planned.** No plan tiers in code; N1 plans one entitlement service. `docs/implementation-backlog.md:171` | Low | Follows the commercial model, not the apps work. |
| Embeddable feeds | Publishes playlists or layouts to websites by iframe or public link, billed by views. | Observed (plan-gated: paid add-on, locked) | **Missing.** Content reaches paired players only, through signed URLs that last 300 s. `packages/contracts/src/limits.ts:64` | Low | Outside the signed-URL delivery model. Also covers the screens feed row. |
| Suggest an app | Opens the support chat; "I'm interested" on concept apps. | Observed | **Missing.** Planned pills tell operators what is coming; nothing collects interest. `apps/portal/src/shell/nav.ts:66-91` | Low | TINNOX staff hear requests directly. |
| App editor actions | Cancel, Preview, Save with save-and-add and save-and-set options, help link. | Observed | **Partial.** Cancel, Save, Delete and a live preview on chosen screens. No save-and-add, no help link. `apps/portal/src/features/apps/AppEditor.tsx:500-615` | Low | |
| Default duration per app | 20 s by default. | Observed | **Missing.** An app enters a playlist at 10 s and is changed per item. `apps/portal/src/lib/playlistDraft.ts:49` | Low | |
| Language per app | Up to 116 locales. | Observed | **Planned.** Fixed to en-AU; a locale choice is deferred. `docs/portal-v2/stage-b.md:808` | Low | Councils serving community languages may ask later. |
| World clock | A time-zone override, city name, themes. | Observed | **Planned.** A deferred app type. The Clock app uses the site zone. `docs/portal-v2/stage-b.md:810` | Low | |
| Clock faces | Analog, date and time, word clock. | Observed | **Partial.** A digital Clock and a separate Date app. A combined item is deferred; no analog or word clock. `packages/contracts/src/app.ts:33-40` | Low | |
| Countdown and count-up | Formats, clock styles, text around the counter; count-up. | Observed | **Partial.** Target in the site zone, a label and a finished text. No formats; count-up deferred. `packages/contracts/src/app.ts:42-54` | Low | |
| Forecast, radar and traffic | Daily and hourly forecasts, radar, weather wall, traffic maps. | Observed | **Planned.** Forecasts under CMS-3; map views as web pages (CMS-18) after the same review. | Low | Current conditions first. |
| RSS feed | Feed address, post count and timing, QR to the article, image options. | Observed | **Planned.** CMS-3, after the P2-06 review. The Ticker reads no feed. `docs/tinnox-mvp-spec.md:245` | Low | School and council news is usually typed by hand. |
| Publisher news feeds | Preset feeds from news publishers; alerts by keyword. | Observed | **Planned.** Would follow RSS under CMS-3. Each publisher's terms need checking. | Low | |
| Ticker | Several items (text or RSS), spacers, bold, italic, size, right-to-left. | Observed | **Partial.** One text up to 300 characters, three speeds, two colours. Wraps under reduced motion. `packages/contracts/src/app.ts:56-64` | Low | RSS items arrive with RSS. |
| Image slideshow from URLs | Image addresses with fit and animation. | Observed | **Missing.** A playlist of uploaded images does the same. | Low | |
| QR code | URL or text, title, subtitle, colours, centre icon. | Observed | **Partial.** Content, caption and colours, generated on the device. `packages/app-render/src/qr.ts:1-16` | Low | The missing parts are cosmetic. |
| Wi-Fi share | A QR code that joins a Wi-Fi network. | Observed | **Planned.** A deferred type. A `WIFI:` string works in the QR app today. `docs/portal-v2/stage-b.md:810` | Low | The password would be copied into publications and player caches. |
| Staff celebrations from a spreadsheet | Birthdays, anniversaries and new hires from an uploaded file. | Observed | **Missing.** | Low | An office use case that would bring staff personal data into the CMS. |
| Quote and trivia feeds | Own items, daily curated items, quotes by keyword. | Observed | **Missing.** Several Text apps in a playlist do the job. `packages/contracts/src/app.ts:75-86` | Low | |
| On-screen player identity | Shows the player's name, ID and location. | Observed | **Partial.** A diagnostics panel on the 'd' key; it cannot be scheduled. `apps/player-web/src/ui/diagnostics.ts:14-17` | Low | Installers can open it on site. |
| TV input switching | Switches the TV to another HDMI input over CEC while it plays. | Observed | **Missing.** No CEC control. Huidu power and brightness are planned (M4). `docs/implementation-backlog.md:160` | Low | TINNOX's LED controllers take the player's HDMI. |
| Custom HTML app | Upload an HTML and JavaScript ZIP with its own settings form. | Observed | **Missing.** P2-06 sets conditions only; no plan. The renderer bans HTML strings and network access. `packages/app-render/src/build-checks.test.ts:5-14` | Low | The riskiest kind of outside content. |
| Scripted web app | A web page plus scripts for log-in or navigation. | Observed | **Missing.** CMS-18 plans unscripted, sandboxed pages only. | Low | Scripted log-ins mean storing third-party credentials. |
| Apps through the API and agent | Create and assign some app types through the REST API and the AI agent (October 2026). | Docs only | **Planned.** J1 plans a read-only API; writes come later. `docs/tinnox-mvp-spec.md:366-370` | Low | |
| Search my apps | Free-text search. | Observed | **Parity.** Search over name and description, plus a type filter. `apps/portal/src/lib/apps.ts:325-335` | n/a | |

TINNOX ahead:

- **Apps work offline and call no third party.** The renderer is barred from network access by a build check, and QR codes are made on the device.
- **The preview is the player.** The editor draws the app with the player's own code, on any of the organisation's screens.
- **Text fits any canvas or zone**, from a 3840x480 LED band to a portrait kiosk, with no font size to pick.
- **Every app change is audited**, and every role can see it.
- **Built for LED legibility**: a contrast warning, white on black by default, and a ticker that wraps for viewers who prefer reduced motion.

### 4.4 Playlists

| Capability | Yodeck | Evidence | TINNOX | Priority | Notes |
|---|---|---|---|---|---|
| Content types in a playlist | Images, video, audio, documents, web pages, apps and layouts; other playlists on Premium. | Observed | **Partial.** Images, H.264 video and six apps. Audio and PDF are CMS-17 (the PDF-first split of DEC-24 is proposed). Web pages wait on P2-06. `packages/contracts/src/playlist.ts:82-84` | High | PDF is the release-1 document type. Layouts and nesting are rated in their own rows. |
| Upload from the playlist editor | Upload links in the strip header and in the empty tile. | Observed | **Missing.** No upload in the editor. A library link shows only when the library is empty. `apps/portal/src/features/playlists/editor/LibraryCard.tsx:291-301` | Medium | Office staff build a playlist and upload in one sitting. |
| Bulk add and remove | Select all in folder view; remove selected. | Observed | **Missing.** One card or tile at a time. The media library has no bulk add to playlist. `apps/portal/src/features/media/library/MediaLibrary.tsx:762-808` | Medium | Building or clearing a 30-image loop one click at a time is the main editing chore. |
| Play-through preview | A preview window plays the playlist. | Observed | **Missing.** Apps and layouts have previews; nothing plays a playlist. Spec 6.6 plans fit previews per item (A6). `docs/tinnox-mvp-spec.md:130-131` | Medium | Editors want to see timing and fit on non-16:9 LED before pushing. |
| Where a playlist is used | Screens, layouts, schedules and playlists that use it. | Observed | **Partial.** Counts only screens assigned directly. Schedules and layouts are named only when a delete is refused. `apps/api/src/routes/playlists.ts:217-219` | Medium | Editors need every screen an edit will reach before they push. |
| Nested playlists | A playlist as an item; its length is left out of the total. | Observed (plan-gated: Premium) | **Planned.** A playlist cannot contain a playlist today. D1 and spec 6.4 plan one level of nesting. `docs/implementation-backlog.md:61` | Medium | TINNOX's simplest answer to one campaign across every site. |
| Who created and changed a playlist | Created by, modified by, link to the log. | Observed | **Partial.** Modified time. Actors are in the audit log, which every role can read for playlists; no link. `packages/contracts/src/audit.ts:43-45` | Low | |
| Bulk actions on playlists | Set to screen and delete. | Observed | **Partial.** Bulk delete only. Assign through the playlist's picker or the Screens list. `apps/portal/src/features/playlists/PlaylistsPage.tsx:601-621` | Low | |
| Tag-based playlist | Fills itself from tag rules (include and exclude), with sorting and a preview list. | Observed (plan-gated: Premium) | **Missing.** Media tags exist; no playlist follows tag rules. `packages/contracts/src/tag.ts:12-21` | Low | Revisit after nested playlists. |
| Playlist from a CSV file | Each line names a media item and a duration. | Observed (plan-gated: Premium) | **Missing.** | Low | Bulk add from the library would cover it better. |
| Black gap between videos | Inserts a black frame between videos. | Observed | **Missing.** The player cuts with no black frame, by design. `apps/player-web/README.md:294` | Low | The gapless cut is the better default for LED walls. |
| Image transitions | 24 effects, speed, custom duration. | Observed | **Partial.** Cut, or a 500 ms fade between two images. Video and apps always cut. `apps/player-web/src/ui/presenter.ts:18-19` | Low | Each effect would need checking on Pi-class and LED routes. |
| Keep web pages open | Keeps pages loaded between turns. | Observed | **Missing.** No web pages yet (CMS-18). | Low | |
| Edit an item's media from its tile | The tile's pencil opens the media editor over the playlist. | Observed | **Missing.** Media is edited on its own page; tiles do not link there. `apps/portal/src/features/media/detail/MediaDetailForm.tsx:191-360` | Low | The leave guard makes the detour safe. |
| Preview items | A lightbox with previous and next. | Observed | **Partial.** Preview only on the media detail page. `apps/portal/src/features/media/detail/MediaPreview.tsx:51-57` | Low | Thumbnails identify most items. |
| Remove expired items | A menu action, disabled when nothing has expired. | Observed | **Missing.** No expired badge either. The player skips expired items. `apps/player-web/src/core/time-rules.ts:82-90` | Low | A badge would explain why an item does not play. |
| Library panel | Chips for every type, search, insert, preview, edit. | Observed | **Partial.** All, Images, Videos and Apps chips, folder and tag filters, an in-draft count. No preview or edit. `apps/portal/src/features/playlists/editor/LibraryCard.tsx:59-64` | Low | |
| Limits per nested playlist | Max items, max time and repeat for each nested item. | Observed (plan-gated: Premium) | **Missing.** D1 plans nesting only. A playlist always starts at its first item. `apps/player-web/src/core/playback.ts:64` | Low | Add after D1 if customers interleave ad sets. |
| Folder view | A three-pane editor with a folder tree and a vertical list. | Observed | **Partial.** A folder select in the library panel; folders are flat. `apps/portal/src/features/playlists/editor/LibraryCard.tsx:181-206` | Low | |
| Hide-playlist item | A placeholder that reveals the layer below in a layout. | Observed | **Missing.** Zones cannot overlap, so there is nothing below to reveal. `packages/contracts/src/layout.ts:45-50` | Low | |
| Content Flows: shared airtime | Global content on every targeted screen, with an airtime budget per level. | Observed (plan-gated: Enterprise) | **Missing.** Nearest: one playlist on many screens, and nested playlists (D1). | Low | Enterprise-only at Yodeck. Also covers the account Content Flows row. |
| Content Flows: levels | Two to five workspace levels; regional editors fill their own. | Observed (plan-gated: Enterprise) | **Missing.** No workspaces; site scoping (H2b) is deferred. `docs/implementation-backlog.md:105` | Low | Needs workspaces first. |
| Content Flows: targeting | All screens or screens with all chosen tags; conflict table; local lock. | Docs only | **Partial.** Screen tags, a tag filter and bulk assign. No standing rule for new screens. `apps/portal/src/features/displays/list/ScreensList.tsx:273-296` | Low | |
| Content Flows: draft and unpublish | Draft, push, and unpublish back to the previous content. | Observed (plan-gated: Enterprise) | **Partial.** Everything is a draft until pushed. Rollback is E4. `docs/implementation-backlog.md:74` | Low | |
| Playlists list | Name, description, modified, media types; sort, search, paging. | Observed | **Parity.** A thumbnail mosaic, items, length and screens columns; sort, search, list or grid. `apps/portal/src/features/playlists/PlaylistsPage.tsx:226-317` | n/a | |
| Assign a playlist to screens | Row menu and "save and set to screen". | Observed | **Parity.** "Assign to screens" picker; the editor's Push card offers assign and push. `apps/portal/src/features/playlists/list/AssignToScreens.tsx:49` | n/a | |
| Duplicate a playlist | Row menu. | Observed | **Parity.** Copies options and items into "Copy of X", in one audited transaction. `apps/api/src/routes/playlists.ts:388-449` | n/a | |
| Delete a playlist | Row menu and bulk. | Observed | **Parity.** Refused while a screen, schedule or layout uses it, naming them. `apps/api/src/routes/playlists.ts:451-550` | n/a | |
| Ordinary playlist | The default type: a hand-ordered sequence. | Observed | **Parity.** The one playlist type; "New playlist" opens the editor. `apps/portal/src/features/playlists/list/NewPlaylistDialog.tsx` | n/a | |
| Name and description | Required name, optional description. | Observed | **Parity.** Name up to 120 characters, description up to 500. `packages/contracts/src/limits.ts:110-112` | n/a | |
| Shuffle | A random playback switch. | Observed | **Parity.** A new order each round, never repeating the last item first. `apps/player-web/src/core/playback.ts:51-69` | n/a | |
| Filmstrip editor | A horizontal strip of tiles in play order. | Observed | **Parity.** Tiles in play order with count and loop length; scrolls while dragging. `apps/portal/src/features/playlists/editor/SequenceCard.tsx:309-342` | n/a | |
| Duration per item | A stepper per image, app or layout; video shows its length. | Observed | **Parity.** 1 s to 1 h per image or app (configurable to 24 h); video plays its own length. `apps/portal/src/features/playlists/editor/SequenceTile.tsx:146-174` | n/a | |
| Reorder by drag | Drag tiles; drop library items at a position. | Observed | **Parity.** Drag and drop with a drop marker, plus Move earlier and Move later buttons. `apps/portal/src/features/playlists/editor/SequenceTile.tsx:222-257` | n/a | |
| Total duration | Shown in the strip header. | Observed | **Parity.** Loop length in the editor and the list. `apps/api/src/routes/playlists.ts:195-236` | n/a | |

TINNOX ahead:

- **Fit per item.** Each media item can use the screen default, contain or cover. Yodeck's tile has only a duration.
- **A richer list**: mosaic, items, length and screens columns, and a grid view.
- **Push status and checks per playlist.** The Push card shows the state of each screen the playlist is assigned to directly, and each push is checked against the screen's route profile.
- **Keyboard ordering.** Move earlier, Move later and Remove on every tile, announced to screen readers.
- **Folder and tag filters in the editor's library**, with "In this playlist 3 times" on each card.
- **Every playlist change audited**, and visible to every role.

### 4.5 Layouts

| Capability | Yodeck | Evidence | TINNOX | Priority | Notes |
|---|---|---|---|---|---|
| Zone position and size | Pixel X, Y, width and height; align to page; drag and resize. | Observed | **Planned.** One preset: a main zone over a band of 5 to 50 %. The database, API and player already take 2 to 4 free zones; the editor cannot set them. `apps/portal/src/lib/layouts.ts:27-29` | High | A header band, side panel or split is a typical first request. Portal-only work (stage B client question 1). |
| Free canvas with overlap | Unlimited elements in pixel boxes, overlapping, in z-order. | Observed | **Partial.** Two to four zones that may not overlap; gaps are black. Overlap needs manifest v6 and player work. `packages/contracts/src/layout.ts:27-55` | Medium | Text over a background or a logo over video is expected soon after launch. |
| Duplicate a layout | Row and bulk menus. | Observed | **Planned.** Deferred in stage B slice 4. `docs/portal-v2/stage-b.md:2812` | Medium | Cheap: playlist duplicate is the pattern. |
| Assign a layout to many screens | Set to screen from the list, the editor and in bulk. | Observed | **Partial.** One screen at a time from the screen page. Bulk assign and the wizard are deferred. `apps/portal/src/features/displays/detail/ContentCard.tsx:368` | Medium | A retailer rolling one layout out to many stores. |
| Layout inside a playlist or schedule | Add a layout to a playlist; schedule events can show a layout. | Observed | **Missing.** Playlist items are image, video or app, with no plan to change. Layouts as schedule events are deferred to manifest v6. `docs/portal-v2/stage-b.md:2815` | Medium | Dayparted menu boards and notices. Also covers the playlists layout-item row (rated Low there). |
| Template gallery | About 230 templates seen; search, categories, orientation filter, import. | Observed | **Planned.** Deferred in stage B. DEC-31 forbids reusing Yodeck's designs. `docs/portal-v2/stage-b.md:2812` | Medium | Needs design elements and designs that adapt to LED shapes first. Also covers the Welcome template card. |
| Text boxes | A text box and three style presets anywhere on the canvas. | Observed | **Partial.** Text comes from a Text or Ticker app in a zone's playlist. `packages/contracts/src/app.ts:56-86` | Medium | School and council notices are mostly typed text. |
| Text formatting | Font, size, weight, italic, underline, alignment, spacing, direction. | Observed | **Missing.** Two colours; size fitted automatically. A band font size is deferred; nothing else is planned. `packages/app-render/src/render.ts:351-356` | Medium | Brand-conscious customers expect size, weight and alignment. |
| Font library | 39 bundled fonts. | Observed | **Missing.** One system font stack. `packages/app-render/src/render.ts:33` | Medium | Fonts must ship with the player: screens play offline and load no remote fonts. |
| Layout preview | A Preview button. | Observed | **Partial.** Zone outlines on chosen screens, with pixel sizes and a small-zone warning. No live content; 1:1 zoom deferred. `apps/portal/src/features/layouts/LayoutPreview.tsx:26-34` | Medium | Outlines do not show crops or a ticker in a thin band. |
| Branded templates | The organisation's own templates, draft and publish, a settings switch. | Observed (plan-gated: Enterprise) | **Missing.** No template object. TINNOX's 2026-11-03 audit rates it "Later". `docs/yodeck-workflow-audit.md:291` | Low | Pays off once site-scoped roles exist (H2b, deferred). Also covers the account branded-templates row. |
| Canvas presets | Landscape, portrait or custom, with ten ratios each. | Observed | **Partial.** A layout has no canvas: zones are fractions. Preview on landscape, portrait or any real screen. `apps/portal/src/lib/apps.ts:292-304` | Low | Adding TINNOX's strip and billboard shapes to "Preview on" would help. |
| Select several elements | Align, resize, lock or delete several at once. | Observed | **Missing.** No element selection. | Low | Useful only on a free canvas. |
| Layers panel | Z-order list; reorder, hide and lock layers. | Observed | **Missing.** Zones never overlap. `docs/portal-v2/stage-b.md:2817` | Low | Follows overlap. |
| Snap and guides | Snap to grid; alignment guides. | Observed | **Missing.** No drag editing. | Low | |
| Editor tools | Undo, redo, zoom, pan, full screen. | Observed | **Partial.** Back link, title, save state, Cancel, Save, Delete. No undo, zoom or pan. `apps/portal/src/features/layouts/LayoutEditor.tsx:175-222` | Low | These arrive with drag editing. |
| Where a layout is used | Playlists, screens and schedules. | Observed | **Partial.** Screen count; names appear when a delete is refused. `apps/portal/src/features/layouts/LayoutEditor.tsx:340` | Low | Enough while only screens can use a layout. |
| Who created and changed a layout | Created by, modified by, audit link. | Observed | **Partial.** Times only. Actors are in the audit log under Layouts, visible to every role. `apps/portal/src/lib/auditView.ts:53` | Low | |
| Layouts list | Thumbnail, sort, search, paging. | Observed | **Partial.** Search, count and sortable columns. No thumbnail, no paging. `apps/portal/src/features/layouts/LayoutsPage.tsx:86-139` | Low | |
| Expired filter on layouts | Expired or non-expired. | Observed | **Missing.** Layouts carry no window. | Low | |
| Layout folders | Add folder and Move. | Observed | **Missing.** Folders exist for media only. | Low | Worth adding past about 100 layouts. |
| Bulk actions on layouts | Add to playlist, set to screen, save as template, duplicate, move, delete. | Observed | **Missing.** `apps/portal/src/features/layouts/LayoutsPage.tsx:54` | Low | |
| Media directly in a zone | Place a library item on the canvas. | Observed | **Partial.** A zone holds a playlist, so a logo needs a one-item playlist. Direct placement is deferred. `docs/portal-v2/stage-b.md:2813` | Low | |
| Apps in the layout editor | An app catalogue in the editor, live on the canvas, settings inline. | Observed | **Partial.** Six apps reach a zone through its playlist. The preview shows outlines, not the app. `apps/portal/src/features/layouts/LayoutPreview.tsx:34` | Low | |
| Custom fonts | Upload font ZIPs in account settings. | Observed | **Missing.** Media accepts JPEG, PNG and MP4 only. `packages/contracts/src/media.ts:23-35` | Low | Needs a font check in the isolated worker. Also covers the media custom-fonts row. |
| Shapes | Shapes with fill, flip, rotation and lock. | Observed | **Missing.** | Low | Decorative. |
| Graphics library | About 250 icons: arrows, signs, badges. | Observed | **Missing.** | Low | Any set must be open-licence (DEC-31). |
| Media controls in a layout | Replace keeping position, crop, fit or stretch, transparency. | Observed | **Partial.** Fit per item: default, contain or cover. Stretch deferred; replace planned (C4). `packages/contracts/src/canvas.ts:4-6` | Low | |
| Element locks | Full lock, size-and-position lock, insert lock for non-admins. | Observed (plan-gated: Premium) | **Missing.** Read-only by role only. `packages/domain/src/permissions.ts:11-46` | Low | Matters once site-scoped roles exist (H2b). |
| Background colour | A colour with transparency. | Observed | **Planned.** Gaps are black; deferred. `docs/portal-v2/stage-b.md:2817` | Low | Preset zones tile the whole screen. |
| Background audio | A soundtrack from a playlist or item. | Observed | **Missing.** Screens play muted; audio media is CMS-17. `packages/contracts/src/manifest.ts:60` | Low | Sound is rare on outdoor LED. |
| Layout availability window | From and to; applies inside playlists. | Observed | **Missing.** No layout window. Media windows already work inside zone playlists. | Low | Only matters once layouts can sit in playlists. |
| Weekly availability for a layout | Hours on chosen days. | Observed (plan-gated: Premium) | **Missing.** Weekly rules exist only as schedule events. | Low | Layouts in schedules would serve this better. |
| Keyboard shortcuts | Duplicate, delete, italic, underline. | Observed | **Missing.** Every control is keyboard-operable, but there are no shortcuts. | Low | Shortcuts come with a canvas of elements. |
| Custom canvas sizes | Saved custom ratios by name, width and height. | Observed | **Parity.** Each screen has its own pixel canvas (16 to 16,384 px, any ratio) and content rectangle. `packages/contracts/src/canvas.ts:54-72` | n/a | Also covers the media custom-ratios row. |
| Delete a layout | Row and bulk menus. | Observed | **Parity.** Refused while a screen has it, naming the screens; audited. `apps/api/src/routes/layouts.ts:268-318` | n/a | |
| Playlist as a zone | Place a whole playlist as a box. | Observed | **Parity.** This is TINNOX's layout model: each zone plays its own playlist. `packages/contracts/src/layout.ts:57-80` | n/a | |

TINNOX ahead:

- **One layout fits every screen shape.** Zones are stored as fractions of each screen's content area, so one layout works on any canvas, rotation and LED mapping. A Yodeck layout is tied to one ratio.
- **A check per screen at push time.** A screen where a zone would be under 16 px is blocked with a reason; the others are pushed.
- **Preview on the organisation's real screens**, with each zone's pixel size.
- **An unsaved-changes guard** in the editor.
- **Layout history for every role.** Every change is audited, and Viewers see it.

### 4.6 Schedules and alerts

| Capability | Yodeck | Evidence | TINNOX | Priority | Notes |
|---|---|---|---|---|---|
| Dated and one-off events | Start and end dates and times; one-off events. | Observed | **Planned.** Weekly rules only: no dates, one-off events or exceptions. Needs a new manifest version (D3; SCH-09 and SCH-10 not met). `packages/contracts/src/schedule.ts:20-28` | High | Campaign end dates and school terms are release-1 uses. |
| Emergency broadcast with expiry | Broadcast to all screens or groups for 2 to 48 hours; cancel. No control was found in the portal. | Docs only | **Planned.** CMS-14. Today: change the content and push, then restore and push again. E2E-01 asks for on screen within 5 minutes. `docs/acceptance-tests.md:149` | High | A school or council sign must show a notice within minutes, then return to normal. |
| Full-screen alert template | A banner, headline, description, instructions and pictogram on a strong colour. | Observed | **Planned.** CMS-14. The auto-fitting Text renderer and per-screen canvas planning exist to build on. `packages/app-render/src/fit.ts` | High | What the public sees. It must read well on non-16:9 LED canvases. |
| Proof of play | An account switch records what played; CSV in UTC, kept 3 months. | Observed (plan-gated: Premium) | **Planned.** The heartbeat reports only the item on screen, sampled every 10 s, kept 24 h and read by nothing. CMS-16, G6, spec 6.11. `packages/contracts/src/player.ts:128` | High | Councils need proof over a reporting period (E2E-03). |
| Assign a schedule to many screens | Set to screen, move and delete in bulk (read from markup; not tried). | Observed | **Planned.** One screen at a time. Bulk and wizard support are deferred (stage B slice 3). `docs/portal-v2/stage-b.md:1552` | Medium | A retailer rolling one schedule out to many sites has to open every screen. |
| Calendar views | Month, week and day; click a slot; event colours. | Observed | **Planned.** A list of weekly events. A week view is D4. `docs/implementation-backlog.md:64` | Medium | Dated events will need a calendar. |
| What an event can show | Layout, playlist, media or app. | Observed | **Partial.** Playlists only. Layouts as events are deferred to manifest v6. `db/migrations/0009_stage_b_schedules.sql:41-48` | Medium | Dayparted layouts have no workaround. |
| Repeat presets | Once, daily, weekdays, weekly, monthly, annually. | Observed | **Partial.** Day toggles cover daily, weekdays and weekly. No once, monthly or annual. `apps/portal/src/features/schedules/ScheduleEventRow.tsx:90-117` | Medium | Arrives with dated events. |
| Repeat until | For ever, until a date, or N times. | Observed | **Planned.** Every event repeats for ever; date ranges planned (D3). `docs/tinnox-mvp-spec.md:276` | Medium | Recurring promotions must stop on a date. |
| Alert type library | Twelve preset types, one per CAP category. | Observed | **Planned.** CMS-14 is a one-line card; prepared types are not designed. | Medium | Australian schools and councils need their own messages more than CAP categories. |
| Alert type editor | Name, icon, category, headline, description, instructions; custom types. | Observed | **Planned.** CMS-14. The roles record suggests Editors and up. `docs/portal-v2/stage-c-roles-decision.md:134` | Medium | |
| Broadcast groups | Named groups of screens, defined by tag. | Observed | **Missing.** CMS-14 says "chosen screens" only. Screen tags exist to build on. `apps/api/src/routes/displays.ts:425` | Medium | Multi-site customers need to alert one site, not every screen. |
| What an alert can show | The template, a layout, a playlist or a file. | Docs only | **Planned.** CMS-14 implies content; the types are not specified. | Medium | An evacuation map or bushfire notice is often an image. |
| Schedules list | Name, modified, filler; search, refresh, paging (columns read from the hidden table); a tour in the empty state. | Observed | **Partial.** Search, refresh and sortable columns. No paging or tour. `apps/portal/src/features/schedules/SchedulesPage.tsx:82-151` | Low | Paging matters past about 100 schedules. |
| Save and assign | Save the schedule and assign it to screens in one step. | Observed | **Missing.** Save, then assign on each screen's page and push. `apps/portal/src/features/schedules/ScheduleEditor.tsx:203-206` | Low | |
| Screen-off events | An event that turns the screen off. | Observed | **Partial.** Working hours blank the output nightly. No timed off inside a schedule. `packages/contracts/src/display.ts:42-54` | Low | Working hours cover the common case. |
| Fit per scheduled item | Fit, crop or stretch. | Observed | **Partial.** Fit per playlist item and per screen; no stretch. `packages/contracts/src/canvas.ts:4-6` | Low | |
| Repeat every N | Every N days, weeks, months or years. | Observed | **Planned.** RFC 5545 recurrence (D3). `docs/implementation-backlog.md:63` | Low | |
| Monthly patterns | Day N, last day, last given weekday. | Observed | **Planned.** Covered by RFC 5545 recurrence (D3). `docs/implementation-backlog.md:63` | Low | |
| Filler content | Layout, playlist, media, app or screen off. | Observed | **Partial.** A required default playlist. `db/migrations/0009_stage_b_schedules.sql:22` | Low | |
| Screens using a schedule | A button lists them. | Observed | **Partial.** A count; names appear when a delete is refused. `apps/api/src/routes/schedules.ts:311-330` | Low | |
| Volume schedules | A calendar of volume levels from 0 to 100 %, with repeats. | Observed (plan-gated: Premium) | **Missing.** Screens play muted; audio is out of release 1. `packages/contracts/src/manifest.ts:60` | Low | Sound must play before its volume can be scheduled. Also covers the screens volume row. |
| Volume schedule per screen | Chosen per screen; 100 % between entries. | Observed (plan-gated: Premium) | **Missing.** The screen's Advanced tab is disabled. `apps/portal/src/lib/screenDetail.ts:49` | Low | |
| Duplicate alert types; where used | Row duplicate; a "used by" dialog. | Observed | **Missing.** Not named by CMS-14. | Low | |
| Alert types per screen | Each screen lists the alert types it shows (read from a hidden screen tab). | Observed | **Missing.** Not named by CMS-14. | Low | Choosing screens per broadcast covers most cases. |
| CAP feed | Inbound alerts from outside alerting systems through a generated URL. | Observed | **Missing.** An inbound feed needs the P2-06 review first. `docs/portal-v2/README.md:16` | Low | No TINNOX customer has named a CAP system yet. |
| Alert display modes | Full screen or ticker, with themes. | Observed | **Missing.** The Ticker app can carry a warning as ordinary content. `packages/contracts/src/app.ts:56-64` | Low | |
| Who may broadcast | A broadcast permission, scoped by workspace. | Docs only | **Planned.** A permission key is reserved for CMS-14. `docs/portal-v2/stage-c.md:49` | Low | |
| Recurring report files | Daily, weekly or monthly CSV files. | Observed (plan-gated: Premium) | **Missing.** The spec plans an on-demand CSV for any date range. `docs/tinnox-mvp-spec.md:154-155` | Low | E2E-03 needs a month on demand. |
| Report archive | A list of generated report files. | Observed (plan-gated: Premium) | **Missing.** On-demand reports need no archive. | Low | |
| Tags in report rows | Screen and media tag columns. | Observed (plan-gated: Premium) | **Missing.** The planned report names no tag columns. | Low | |
| Report viewer group | A group for playback reports. | Observed (plan-gated: Enterprise) | **Planned.** The reserved key gives reports to all four roles. `docs/portal-v2/stage-c-roles-decision.md:136` | Low | |
| Reports through the API | An endpoint returns a CSV link. | Docs only | **Planned.** J1's read-only API includes playback logs. `docs/implementation-backlog.md:121` | Low | |
| Schedule editor | Name, Cancel, Save, back link. | Observed | **Parity.** Name and description, Cancel and Save, Delete; read-only for Viewers. `apps/portal/src/features/schedules/ScheduleEditor.tsx:237-255` | n/a | |
| Add, edit and remove events | An add button and a delete in each event. | Observed | **Parity.** Up to 50 events, each edited in place. `packages/contracts/src/limits.ts:105` | n/a | |
| Chosen weekdays | Seven day toggles. | Observed | **Parity.** Seven Monday-first toggles; at least one required. `apps/portal/src/features/schedules/ScheduleEventRow.tsx:90-117` | n/a | |
| Edit a series | Edits change the whole series. | Observed | **Parity.** An event is one weekly rule, so an edit changes every occurrence. | n/a | |
| Priority by list order | Order sets which overlapping event wins. | Observed | **Parity.** First event with something to show wins; Move up and Move down. `apps/portal/src/features/schedules/ScheduleEventRow.tsx:163-181` | n/a | |
| Each screen's local time | Schedules run in each screen's zone. | Observed | **Parity.** The site's IANA zone travels in the manifest; the player decides offline. `packages/contracts/src/manifest.ts:144-145` | n/a | |
| Assign a schedule on the screen page | Schedule is one content type. | Observed | **Parity.** Playlist, schedule or layout; one at a time, enforced by the database. `apps/portal/src/features/displays/detail/ContentCard.tsx:259-298` | n/a | |

TINNOX ahead:

- **Pre-push checks that name the failing event**, such as `events[2].playlist`. A refused screen keeps playing what it has.
- **Empty or failed content is skipped, not shown blank.** The player falls through to the next event or the default, and an untrusted clock plays the default.
- **Daylight-saving behaviour tested for Australian zones**, Lord Howe included. Two edge cases still depart from TINNOX's own spec (SCH-03, SCH-05).
- **In-use guards** for schedules and the playlists they use, with database backstops.
- **Every schedule change audited**, visible to every role.
- **A keyboard-operable editor** with plain-words errors linked to each control. The screen-reader pass (CMS-6) is still open.

### 4.7 Screens and players

| Capability | Yodeck | Evidence | TINNOX | Priority | Notes |
|---|---|---|---|---|---|
| Kiosk-grade player runtime | Players boot straight to playback and recover unattended; Android app pinning. | Docs only | **Planned.** The browser page cannot go full screen, hold a wake lock or reopen after a crash. On the Pi 5 a power cut wiped the player in 2 of 5 cuts. CMS-42, Epics F and I. `apps/player-web/README.md:560-590` | High | Blocks the first real installation. |
| Remote player commands | Reload and screen on or off; reboot and shutdown on hardware players; also in bulk. | Observed | **Planned.** No command channel; the player only polls. CMS-38 and F5. `docs/implementation-backlog.md:84` | High | A reload is the only way to a new manifest version. Each avoided site visit is SLA margin. |
| Automatic player updates | Automatic upgrades on every plan. | Docs only | **Partial.** A new build arrives only when the player page next loads. F6 plans signed updates with a window and rollback. `infra/deploy/Caddyfile:38-40` | High | Without it, every player release needs someone at each screen. |
| Screenshots | The latest screenshot with its capture time, taken periodically. | Observed | **Planned.** The screen page draws a labelled mock. CMS-38, F5 and G2. `docs/implementation-backlog.md:93` | High | Seeing a screen without a site visit is scenario 4. |
| Player telemetry | Versions, resolution, storage, uptime, RAM; temperature, HDMI and IP on hardware. | Observed | **Partial.** Build and storage flags are kept 24 h and shown nowhere. F2 and G5 plan temperature and throttling. `packages/contracts/src/player.ts:142-148` | High | Heat, full storage or network faults in an outdoor cabinet must be diagnosed remotely. |
| Screen takeover | Content plus a duration (indefinite, 30 min, 1 h, custom), stop; from the row, the page, in bulk or from a media item. | Observed | **Planned.** CMS-14. Today: assign other content and push, then restore and push. `docs/portal-v2/README.md:27` | High | Docs say a takeover outside working hours still leaves the screen off; the portal form says it overrides working hours. Also covers the media and schedules takeover rows. |
| Bulk actions on screens | On, off, reboot, shutdown, clear session, takeover, edit, delete. | Observed | **Partial.** Assign a playlist, edit tags, push, and delete (on main). No commands, takeover or bulk settings. `apps/portal/src/features/displays/list/ScreensList.tsx:901-948` | Medium | Multi-site retailers change many screens at once. |
| Health and troubleshooting | Last screenshot, last seen, content status; a "why is this offline" link. | Observed | **Partial.** Status with an explanation, report age, desired, downloaded and playing, errors. The triage panel is G4. `apps/portal/src/features/displays/detail/OverviewTab.tsx:104-209` | Medium | Office staff need a first step before raising a ticket. |
| Display power | Screen on or off over HDMI-CEC; backlight off on some TVs. | Observed | **Partial.** Working hours blank the output; the display stays powered. Huidu on and off is planned (M4). `apps/player-web/README.md:195-196` | Medium | LCD kiosks keep their backlight on all night. |
| Time zone per screen | A zone selector per screen. | Observed | **Partial.** The zone comes from the screen's site. Sites are made only by the staff CLI; no re-zone or move (B5, D5). `scripts/lib/provision.ts:515` | Medium | A retailer across states needs several zones from the start. |
| Output resolution | Auto, or 1080p and 720p at set refresh rates. | Observed | **Planned.** The browser scales to whatever the device outputs. Forcing the HDMI mode is F3 on the native player. `docs/implementation-backlog.md:82` | Medium | LED sender cards often expect a fixed input timing. |
| Media tag filtering per screen | Rules that include or exclude media by tag on each screen. | Observed (plan-gated: Premium) | **Missing.** Per-site variation needs a separate playlist per screen. | Medium | Per-site exceptions for retailers without copying playlists. |
| Special working hours | Date exceptions that replace the weekly hours. | Observed | **Missing.** Hours and events are weekly only. `docs/portal-v2/stage-b.md:1548` | Medium | School terms and public holidays. |
| On-screen player messages | Hide diagnostics and player messages. | Observed | **Partial.** Diagnostics are hidden by default, but "Waiting for content" and a failure notice show publicly. `apps/player-web/README.md:78-86` | Medium | Spec 14.1 asks for no public-facing error dialogs. |
| Lock down the player | Locks the device against tampering. | Observed (plan-gated: Enterprise) | **Planned.** Read-only root (F1) and Android lock-task mode (I1). Today the 'd' key and a two-click reset are open to any keyboard. `apps/player-web/src/ui/diagnostics.ts:18-40` | Medium | Public outdoor kiosks need tamper resistance. |
| Encrypted media on the player | Encrypted cache, with key options. | Observed (plan-gated: Enterprise) | **Missing.** A CMS-42 note says "consider". A stolen device that stays offline keeps its token and media. `apps/player-web/README.md:372-381` | Medium | Government and council buyers assess data on devices. Also covers the account player-encryption row. |
| Wi-Fi settings | Scan, security types, enterprise log-in, a fallback network. | Observed | **Missing.** The network is set by hand on site; no story covers remote changes. | Medium | Changing it later needs a site visit. |
| Proxy settings | A proxy with authentication and exceptions. | Observed | **Planned.** Spec 14.6 requires proxy support at provisioning; no backlog story. `docs/tinnox-mvp-spec.md:345` | Medium | Council, university and government networks often force a proxy. |
| Supported players | Pi, Android, FireOS, browser, Windows, Tizen, BrightSign, webOS, ChromeOS. | Observed | **Partial.** Browser player only. Native CM5 (Epic F), Android (Epic I) and Huidu (Epic M) are planned. `docs/implementation-backlog.md:76-85` | Medium | TINNOX supplies its own players, so depth matters more than breadth. |
| Screen licence limit | A fixed number of screens per account. | Observed | **Planned.** No seat limit; B3 and N3. `docs/implementation-backlog.md:41` | Medium | Needed to sell plans per display. |
| Pre-provisioning | Players bound to the buying account before they arrive. | Docs only | **Planned.** A claim token in the image (B4) and hardware binding (B3). `docs/tinnox-mvp-spec.md:166` | Medium | Saves installer time on every job. |
| Column chooser | Optional hardware columns; drag to reorder. | Observed | **Missing.** Fixed columns. | Low | The columns need telemetry first. |
| Export the list | A CSV export. | Observed | **Missing.** | Low | TINNOX already holds the install records. |
| Duplicate a screen | Copies a screen's settings. | Observed | **Missing.** | Low | Each device still needs pairing. |
| Who created and changed a screen | Created by, modified by, log link. | Observed | **Partial.** Added time and ID. Actors only in the audit log. `apps/portal/src/features/displays/detail/DetailsCard.tsx:189-207` | Low | |
| Location and map | Location from the player's address or a pin; a dashboard map. | Observed | **Missing.** A site holds a name and a zone only. A hosted map would break D18. `db/migrations/0001_schema.sql:65-73` | Low | Needs site addresses first. Also covers the dashboard map row. |
| Web player install checks | Extension and installed-app state; a sound warning. | Observed | **Partial.** The player reports whether storage is persistent; only the device shows it. `packages/contracts/src/player.ts:146-148` | Low | Showing a refusal would explain the Pi 5 wipes. |
| What a screen can show | Layout, playlist, media, app, schedule, web page or off. | Observed | **Partial.** A playlist, schedule or layout. A single item needs a one-item playlist. `packages/contracts/src/display.ts:97-102` | Low | Also covers the set-to-screen rows from media and apps. |
| Sound output | Auto, HDMI, analogue or muted. | Observed | **Missing.** No audio at all. | Low | |
| Working hours mode | Always on, a workspace default, or custom. | Observed | **Partial.** Per screen only: always on or seven-day hours. No default. `apps/portal/src/features/displays/detail/WorkingHoursTab.tsx:120` | Low | |
| Several ranges per day | Ranges per weekday; copy to all days. | Observed | **Partial.** One range per day, or closed. `packages/contracts/src/display.ts:42-54` | Low | Also covers the schedules working-hours row. |
| Offline e-mails per screen | A delay up to 48 h, notify while off, back online, recipients. | Observed | **Partial.** 30 min to 48 h, a back-online e-mail, only open hours count; one organisation list. `apps/api/src/alerts.ts:80` | Low | No production alert e-mail until CMS-35. |
| Scheduled reboot | A time and weekdays. | Observed | **Missing.** A watchdog (F1) and remote reboot (F5) are planned. | Low | Also covers the schedules timed-events row. |
| Download window | Hours when new content downloads. | Observed | **Missing.** F6's window is for software updates only. | Low | Matters on metered 4G links. |
| Low-level player settings | Configuration directives; a boot-config override. | Observed | **Missing.** TINNOX builds its own image (F1). | Low | |
| Player security settings | Passwords, firewall, SSH, remote support, custom certificates. | Observed | **Missing.** The native player has no inbound ports by design. | Low | Custom certificates may be needed on networks that inspect TLS. |
| Mobile data | A USB LTE dongle with SIM settings. | Observed | **Missing.** Remote sites use an external 4G router with VPN (DEC-10, M5). | Low | |
| Static IP, DNS and NTP | Static network settings and custom time servers. | Observed | **Missing.** The player corrects its clock from server time. `apps/api/src/routes/player.ts:768` | Low | Set at installation. |
| Platform choice in Add screen | Player, smart TV or browser; advanced setup. | Observed | **Missing.** One route. `apps/portal/src/lib/screenWizard.ts:22` | Low | Needed once a second route exists. |
| Setup instructions | Steps, video and a guide per platform. | Observed | **Partial.** Three how-to steps in the pairing step. `apps/portal/src/features/displays/wizard/PairStep.tsx:151-190` | Low | TINNOX installers pair the players. |
| Content step in Add screen | Content with a live preview; save and push. | Observed | **Partial.** A playlist with a mosaic and Push now. Schedules and layouts deferred. `apps/portal/src/features/displays/wizard/ContentStep.tsx:45-58` | Low | |
| Boot logo | A custom boot image, unlocked by rating Yodeck. | Observed (plan-gated: rating, locked) | **Missing.** Only a holding slate for an expired licence is planned (DEC-26). | Low | |
| Clear browser session | A bulk command. | Observed | **Partial.** A local reset on the device; revocation wipes the player. `apps/player-web/src/app.ts:618` | Low | |
| Audience measurement | Camera-based audience setup. | Observed | **Missing.** | Low | Privacy Act questions; no customer has asked. |
| Screens list columns | Name, status, type, ID, content, working hours. | Observed | **Parity.** Name, Status, Content, Site, Canvas, Tags. `apps/portal/src/features/displays/list/ScreensList.tsx:493-534` | n/a | |
| Sort the list | Several columns sort. | Observed | **Parity.** Name, Status, Content, Site and Canvas. | n/a | |
| Search the list | A search box. | Observed | **Parity.** Name, description, site, content and canvas. `apps/portal/src/lib/screensList.ts:105-114` | n/a | |
| Status filter | Online, offline, unregistered. | Observed | **Parity.** Four status groups with counts, several at once, kept in the URL. `apps/portal/src/lib/screensList.ts:120-136` | n/a | |
| Tag filter | Search screens by tags. | Observed | **Parity.** Several tags, any match; bulk tag editing. `apps/portal/src/lib/tagColours.ts:138-146` | n/a | |
| Grid view | Cards with the latest screenshot. | Observed | **Parity.** Tiles with a to-scale canvas diagram and push state; no screenshot yet. `apps/portal/src/features/displays/list/ScreenFrame.tsx:13-21` | n/a | |
| Paging | Count, page size, page numbers. | Observed | **Parity.** Count and 10 to 100 per page. `apps/portal/src/ui/Pagination.tsx:25` | n/a | |
| Status indicators | Online, offline, unregistered; a content-updated tick. | Observed | **Parity.** Eight states with explanations, plus push state per screen. `apps/portal/src/lib/screenStatus.ts:19-80` | n/a | |
| Delete a screen | Row menu and bulk. | Observed | **Parity.** On main (CMS-41, PR #54): row, bulk and screen page; revokes the player; audited. `origin/main:apps/api/src/routes/displays.ts:469` | n/a | Not yet on this worktree's branch. |
| Name and description | Required name, optional description. | Observed | **Parity.** Both editable and audited. `apps/api/src/routes/displays.ts:310` | n/a | |
| Move a screen to another device | Register a different device. | Observed | **Parity.** A new code replaces the device and revokes the old one in one transaction. `apps/api/src/routes/displays.ts:480-512` | n/a | |
| Save, then push | Save, or save and push to this screen. | Observed | **Parity.** Assign, then push (P2-05); "Push to this screen". `apps/portal/src/features/displays/detail/SummaryCard.tsx:86` | n/a | |
| Tags on a screen | Tags with a manage link. | Observed | **Parity.** A tag set per screen. `apps/api/src/routes/displays.ts:425` | n/a | |
| Orientation | Four rotations. | Observed | **Parity.** 0, 90, 180 or 270 per screen. `packages/contracts/src/canvas.ts:9` | n/a | |
| Overscan | Pull the picture in from each edge. | Observed | **Parity.** The content rectangle insets content, with black outside. `packages/contracts/src/canvas.ts:54-72` | n/a | |
| Pairing by code | One code box and Register. | Observed | **Parity.** An 8-character code, valid 10 minutes, throttled and audited. `apps/api/src/routes/player.ts:212-301` | n/a | |
| Screen tags page | An account list of screen tags. | Observed | **Parity.** Media and Screen tabs with colours and usage counts. `apps/portal/src/features/settings/TagsPage.tsx:69-86` | n/a | |

TINNOX ahead:

- **Custom pixel canvas and content rectangle** for any LED size. Yodeck's LED support is a forced-resolution and overscan workaround. Exact output mapping waits on the native player (F3).
- **Delivery progress per screen**: what it should have, what it downloaded and verified, and what it is playing.
- **Honest status wording.** Eight states with the age of the last report; the portal never claims "online".
- **Pre-push checks per screen.** A blocked screen keeps playing what it has, and the reasons name each item.
- **A failed update never interrupts playback.** Downloads resume, are checked by length and SHA-256, and switch over atomically.
- **No offline playback cut-off.** Yodeck stops playback 30 to 40 days after a player loses internet. Caveat: the browser cache can be evicted, so this fully holds only with the native player (CMS-42).
- **Shorter offline-alert defaults** (30 minutes, back-online on) and external alert addresses with double opt-in.
- **Device credentials hashed and bound to one screen**; media URLs are signed and short-lived, the registration is re-checked on every media request, and a revoke takes effect on the server at once. Yodeck's side cannot be observed, so this is a TINNOX strength rather than a measured lead.
- **Every screen change audited**, visible to every role. Known residual: an alert closed without an e-mail writes no row (CMS-36).

### 4.8 Account, users and security

| Capability | Yodeck | Evidence | TINNOX | Priority | Notes |
|---|---|---|---|---|---|
| Customer off-boarding and deletion | A button to request deletion of the whole account. | Observed | **Planned.** No deletion path. H3 plans purge with a report; `org.delete` is reserved; checklist item 13. `docs/implementation-backlog.md:107` | High | A stage 1 gate. A staff-run, audited procedure is enough. Also covers the profile deletion row. |
| Self-service password and authenticator reset | Change the password, reset it by e-mail, reset the two-factor token. | Observed | **Planned.** Recovery is staff-only (Cognito `admin_only`, then `mfa-reset`). A3; deferred until e-mail. `infra/aws/identity.yml:83-87` | High | Every lockout is a TINNOX ticket. Also covers the profile password row. |
| Staff support access | Partner staff can sign in as any customer user; on by default. | Docs only | **Planned.** No staff path at all. Customer-granted access (DEC-17, B+) is H1, a stage 1 gate. `docs/implementation-backlog.md:103` | High | Scenario 4 and the SLA need staff inside an account, with the customer's consent. |
| Sub-processor and data-location statement | A public list: AWS Ireland and Sweden, plus US sub-processors. | Docs only | **Partial.** An internal inventory exists. The customer statement and provider review are checklist items 2 and 4. `docs/security/operations-and-release-checklist.md:307-309` | High | Required before the first external customer. The inventory's identity row is out of date. |
| Invite a user | E-mail, allowed addresses, workspace, groups, roles; the invite goes at once. | Observed | **Partial.** An Admin records the request; TINNOX staff complete it by CLI; Cognito sends the mail (50 a day). `apps/api/src/routes/members.ts:515-593` | Medium | The pilot design (DEC-35). CMS-20 plans invites without TINNOX. |
| Predefined roles | Five workspace roles plus Global Admin and Billing. | Observed (plan-gated: Enterprise) | **Partial.** Owner, Admin, Editor, Viewer. No role that edits but cannot push (Contributor deferred), no content-only role. `packages/domain/src/permissions.ts:11-46` | Medium | Councils want an author who cannot publish (scenario 3). Neither product has an approval queue; Yodeck's nearest is a role that edits but cannot push. |
| Roles per site | A role on a named workspace, as an exception. | Observed (plan-gated: Enterprise) | **Planned.** One role across the organisation; site scoping (H2b) deferred. `docs/implementation-backlog.md:105` | Medium | Regional managers limited to their own sites. |
| Workspaces | Create and manage workspaces; a header switcher that scopes the whole app. | Observed (plan-gated: Enterprise) | **Planned.** An organisation gets one site at creation, and no route adds sites or scopes by site; sites as workspaces are listed under Later. The header capsule is reserved as the switcher. `docs/portal-v2/README.md:47` | Medium | Also covers the workspace rows from shell, media and schedules. |
| API tokens | Generate tokens scoped by role and workspace. | Observed (plan-gated: Premium) | **Planned.** Settings shows "API tokens" as Planned; J1 service tokens. `apps/portal/src/lib/settingsView.ts:183-188` | Medium | Larger customers will feed screen status into their own monitoring. |
| Public REST API | Read and write across screens, content, users and reports. | Docs only | **Planned.** J1: read-only OpenAPI endpoints; writes later. `docs/tinnox-mvp-spec.md:364-372` | Medium | Read access to status and proof of play is the first ask. |
| Audit log filters | Search, date range, sorting; address and session columns. | Observed (plan-gated: Enterprise) | **Partial.** Category and result filters; search covers loaded pages only. No date, actor or object filter. `apps/api/src/routes/audit.ts:37-98` | Medium | "Who changed what last week" needs a date range. |
| Audit log export | Daily files as TXT, CSV or JSON. | Observed (plan-gated: Enterprise) | **Planned.** The spec promises export; no backlog story. `docs/tinnox-mvp-spec.md:265` | Medium | Government customers keep records under their own rules. |
| Security certifications | ISO 27001 and 9001; questionnaire help on the top plan. | Docs only | **Missing.** A threat model and control matrix, which state they are not a compliance claim. `docs/security/control-matrix.md:10` | Medium | Government and banking buyers send security questionnaires. |
| Service SLA | Published monthly uptime targets with credits: 96 % on Basic and Premium, 99.9 % on Enterprise; Free excluded. Response targets in business hours. | Docs only | **Planned.** A 99.9 % target is recommended for paying customers after stage 2. `docs/deployment-plan-2026-11-24.md:250-256` | Medium | TINNOX's published SLA covers hardware faults only. |
| Subscription page | Plan, renewal, payment method, licences, currency, invoices. | Observed | **Planned.** Entitlements, licence states and reminders (N1 to N5). No customer plan page specified. `docs/implementation-backlog.md:171-175` | Low | |
| Licence checkout | A multi-step order wizard with a coupon. | Observed | **Planned.** Later direction in DEC-35; CMS-20 is a placeholder. `docs/decisions-2026-11.md:50` | Low | Also covers the Upgrade entry point in the user menu. |
| Free trial | A 30-day trial with a countdown banner. | Observed | **Planned.** A demo licence state and a portal-only grace banner (DEC-26, N2). A trial is undecided (CMS-20). `docs/decisions-2026-11.md:41` | Low | Also covers the shell trial banner. |
| Users list | Name, e-mail, roles, workspace, groups, last login. | Observed | **Partial.** Name, role, first sign-in, a Removed view. No e-mail by design; last sign-in deferred. `apps/portal/src/features/users/UsersPage.tsx:161-208` | Low | |
| Export users | A CSV export. | Observed | **Missing.** | Low | |
| Bulk user changes | Edit or delete ticked users (markup only). | Observed | **Missing.** One person at a time. | Low | |
| Screen quota per workspace | A screen limit per workspace. | Observed (plan-gated: Enterprise) | **Missing.** Seats are planned per customer only (N3). | Low | |
| Workspace hierarchy | Parent workspaces and sub-workspaces. | Observed (plan-gated: Enterprise) | **Missing.** | Low | |
| Password policy settings | Reset, rotation, first-sign-in and complexity switches. | Observed (plan-gated: Enterprise) | **Partial.** One fixed policy: 12 characters, TOTP for everyone, staff-only recovery, a new password at first sign-in. `infra/aws/identity.yml:77-97` | Low | Forced rotation runs against current ISM guidance. |
| Session policies | Sign-out after inactivity; one session only. | Observed (plan-gated: Enterprise) | **Partial.** 30-minute idle and 8-hour limits, per deployment. No single-session rule. `apps/api/src/config.ts:121-122` | Low | |
| Webhooks | Webhooks in the API specification. | Docs only | **Planned.** Release 2, signed with retries (Epic L). `docs/implementation-backlog.md:143` | Low | |
| AI agent over the API | An agent for chat assistants that reads and changes the account. | Docs only | **Missing.** Needs the public API first. | Low | |
| Connected apps | Third-party apps a user authorised, with revoke. | Observed | **Missing.** No OAuth provider, so nothing to list; needs J1. | Low | Also covers the profile connected-apps row. |
| Branded portal | Logos and a main colour per appearance. | Observed (plan-gated: Enterprise) | **Missing.** One TINNOX identity (DEC-31, DEC-34). `infra/aws/identity.yml:102-112` | Low | Matters mainly for resellers. |
| Notification centre | A header panel with All and Unread (markup only). | Observed | **Missing.** The dashboard's Needs attention list and e-mail alerts stand in. | Low | |
| Several customers per sign-in | Partner accounts manage many client accounts. | Docs only | **Planned.** One organisation per sign-in; H2c deferred. `db/migrations/0001_schema.sql:54-63` | Low | |
| Account settings page | Grouped rows with value and plan badge. | Observed | **Parity.** Same pattern; Planned rows show their stage. `apps/portal/src/features/settings/SettingsPage.tsx:187-300` | n/a | |
| Users search and paging | Search, filters, page size. | Observed | **Parity.** Search, sort, paging, Current or Removed. `apps/portal/src/features/users/UsersPage.tsx:103-133` | n/a | |
| Owner protection | The owner's row cannot be changed. | Observed | **Parity.** Goes further: a trigger keeps one active Owner; nobody changes themselves. `db/migrations/0013_roles_and_members.sql:96-152` | n/a | |
| Audit retention | Customer log kept 90 days, Enterprise only (help centre). | Docs only | **Parity.** No purge today; 24 months for every customer proposed (DEC-18). `docs/decisions-2026-11.md:33` | n/a | The purge path is a stage 1 gate. |
| Two-factor authentication | Optional per user; enforcing it is Enterprise. | Observed | **Parity.** Required for every user; the API refuses sign-ins without MFA evidence. `infra/aws/identity.yml:80-82` | n/a | Also covers the profile two-factor row. |
| Unlimited users | Every plan. | Docs only | **Parity.** No user limit today. | n/a | N3 plans a user quota on Essential, which would put TINNOX behind. |

TINNOX ahead:

- **MFA required for every user**, checked by the API at every sign-in. Yodeck makes it optional.
- **An audit log for every customer and role**, written in the same transaction as each change and append-only. Yodeck's is Enterprise-only, kept 90 days. Known residuals are open on CMS-36: three writes kept unaudited, and pairing requests refused as rate-limited or after code collisions.
- **Revocation that a live sign-in cannot get around.** Removal, demotion or "Sign out everywhere" ends sessions at once, a later sign-in older than the cut-off is sent back to the identity provider to sign in again (`prompt=login`; whether Cognito honours it is unverified pending runtime), and the role is re-read inside every write.
- **Last-Owner protection and rank rules** enforced in the database and the API.
- **No standing vendor access.** Planned staff access needs a customer grant, is time-limited and appears in the customer's own log.
- **Tenant isolation enforced by the database** (forced row-level security), and another organisation's ID gets the same 404 as an unknown one.
- **All data held in Australia**, with no third-party analytics, CDN or remote fonts. Yodeck holds data in AWS Ireland and Sweden.
- **Minimal personal data.** No member e-mail is stored (an invite's e-mail is deleted when the invite closes), and audit rows never hold names, e-mail addresses, client addresses or tokens (device refusals keep only a keyed fingerprint of the address).
- **Break-glass Owner recovery** needs a second, different staff approver.
- **Unsafe production configuration is refused at start-up.** This is internal: customers do not see it.

## 5. Deliberately out of scope

These Yodeck capabilities are excluded by a recorded decision. They are not oversights. Decision sources: P2-06 (`docs/portal-v2/README.md:16`), D18 (`docs/prototype-m0.md:34`), DEC-35 and its roles record (`docs/decisions-2026-11.md:50`, `docs/portal-v2/stage-c-roles-decision.md:376`), DEC-27 (`docs/decisions-2026-11.md:42`), DEC-03 (`docs/decisions-2026-11.md:18`), and the MVP spec's release-1 scope and separate product decisions (`docs/tinnox-mvp-spec.md:73`, `:241-243`, `:250`).

| Capability | Area | Decision | Note |
|---|---|---|---|
| In-app help chat with an AI agent | Shell | D18, P2-06 | A third-party script and data flow. A plain help link covers the need. |
| Edit your own name, e-mail and phone | Shell | DEC-35 (D7) | Nobody changes their own membership. The CMS stores no member e-mail or phone. |
| Cookie preferences | Shell | D18 | Only strictly necessary session cookies, so nothing to consent to. Also covers the account profile-privacy row; its newsletter part stays a shell row. |
| Import from cloud drives | Media | P2-06 | |
| Stock images and video | Media | P2-06 | The Stock tab in Add media is disabled. |
| YouTube and Vimeo | Media | P2-06; spec section 9 | |
| Live video and audio streams | Media | Spec section 9 | A separate product decision. |
| Video walls from several players | Media | Spec section 9 | TINNOX's LED walls are one canvas behind one controller. Also covers the screens video-wall row. |
| HDMI capture and webcam input | Media | Spec section 9 | |
| Paid content add-ons | Apps | P2-06, DEC-27 | Needs billing and a content partner. CMS-20 may bring billing later. |
| BI and business-data dashboards | Apps | P2-06 | Link-only embeds could later ride on web pages (CMS-18). |
| Integrations that store third-party log-ins | Apps | P2-06 | Also against controls B6 and B14: players are untrusted and hold only their own credential. |
| Project and planning tools | Apps | P2-06 | |
| Google and Outlook calendars | Apps | P2-06 | |
| ICS calendar feeds | Apps | P2-06 | Provider-neutral, so it could return as a feed under the CMS-3 review. |
| Meeting-room and town-hall integrations | Apps | P2-06; spec section 9 | |
| Social feeds, social walls and review feeds | Apps | P2-06 | Retailers may ask later. |
| Workplace communication and HR feeds | Apps | P2-06 | |
| Interactive kiosk | Apps | Spec section 9 | First to revisit when a touch kiosk sale needs it. |
| Interactive library and interactive playlist | Apps | Spec section 9 | Also covers the playlists interactive row. |
| Design-tool and menu-board integrations | Apps | P2-06 | Customers export and upload. Canva is the likeliest request. |
| AI assistant in editors | Apps | P2-06, D18 | |
| Wayfinding built from kiosk apps (docs only) | Apps | Spec section 9 | Static floor maps already play as images or video. |
| Live cloud-folder playlists | Playlists | P2-06 | |
| Synchronised playback across screens | Playlists | Spec section 9 | |
| AI layout generation | Layouts | P2-06 | Would also send prompts and brand assets offshore (DEC-13). |
| AI text rewriting | Layouts | P2-06 | Same offshore concern. |
| US weather service alerts | Schedules and alerts | DEC-03 | Release 1 serves Australia only. An Australian feed would need the P2-06 review. |
| Touch screen and on-screen keyboard | Screens | Spec section 9 | |
| GPIO input | Screens | Spec section 9 | |
| Hardware store and player offers | Screens | P2-06 (player shop) | TINNOX sells and installs its own hardware. Also covers the account store row and the shell upgrade-and-buy entries. |
| Invoices | Account | DEC-27, P2-06 | Tax invoices come from TINNOX's accounting system. |
| Billing entities | Account | DEC-27, P2-06 | |
| Add-ons library | Account | P2-06 | Warranty extensions are a TINNOX sales item. |
| IP address allow-list | Account | DEC-35 (roles record) | Revisit when a government buyer asks. |
| Built-in user groups | Account | DEC-35 | Four fixed roles cover the pilot. |
| Custom user groups | Account | DEC-35 | Needs workspaces first. |
| Custom role editor | Account | DEC-35 | Moving a key between roles is a one-line change. |
| Social sign-in | Account | Spec section 4 (SSO out of release 1) | TINNOX creates every account. Also covers the profile Google sign-in row. |
| SAML single sign-on | Account | Spec sections 4 and 9 | "When a customer requires it." Universities and state bodies are likely to ask. |
| SSO user creation and group mapping | Account | Spec sections 4 and 9 | Follows SSO. |
| SCIM user provisioning | Account | Spec section 4 | |
| AI content creation switch | Account | P2-06 | Also covers the media AI row. |

## 6. Suggested order of work

Status: **PROPOSED.** This groups the 18 High and 64 Medium gaps into eight packages, in a suggested order. It is for TINNOX to approve or amend.

1. **Native player and remote operations** (CMS-42, CMS-38, Epics F and G). It blocks the first real installation.
   - High: kiosk-grade runtime, automatic updates, remote commands, screenshots, telemetry.
   - Medium: health and troubleshooting (G4), on-screen messages, display power, output resolution (F3), lock down, encrypted media, Wi-Fi settings, proxy settings, supported players, pre-provisioning (B4), bulk actions on screens.
2. **Pre-customer trust and account recovery.** Most of it is a stage 1 gate.
   - High: staff support access (H1), off-boarding (H3), sub-processor and data-location statement, self-service password reset (A3).
   - Medium: invites without TINNOX (CMS-20), audit log filters, audit log export, security certifications (start with an answer pack for security questionnaires), a service SLA, a help and support link (J2).
3. **Emergency messages and takeover** (CMS-14). Needed for the school and council scenario and E2E-01.
   - High: emergency broadcast, full-screen alert template, screen takeover.
   - Medium: alert type library, alert type editor, broadcast groups, what an alert can show.
4. **Scheduling and proof of play** (D3, D4, CMS-16, G6).
   - High: dated and one-off events, proof of play.
   - Medium: calendar views, repeat presets, repeat until, what an event can show, assigning a schedule to many screens, special working hours, weekly availability slots, the media expired filter, app availability windows.
   - Dated events and layouts as schedule events both need manifest v6; plan them together with package 6.
5. **Documents and the media pipeline** (CMS-17, C1, C3, C4).
   - High: PDF documents, content types in a playlist, wider video input.
   - Medium: PowerPoint, image formats, upload size limits, local upload (resumable, C1), storage allowance (N3), replace a file, bulk edit, upload from the playlist editor, bulk add to a playlist, play-through preview.
6. **Layout designer and text** (stage B client question 1, manifest v6).
   - High: zone position and size.
   - Medium: free canvas with overlap, duplicate a layout, assign a layout to many screens, layouts inside playlists and schedules, template gallery, text boxes, text formatting, font library, layout preview, app styling, rich text.
7. **Multi-site and integration** (H2b, B5, D5, N3, J1, D1).
   - Medium: workspaces, roles per site, a Contributor role, time zone per screen (editable sites), media tag filtering per screen, nested playlists, where a playlist is used, screen licence limit, API tokens, public REST API.
8. **Outside content after the P2-06 review** (CMS-18, CMS-3).
   - Medium: web page item, embed app, current weather.

## 7. What this report could not check

On the Yodeck side:

- **Plan.** The account is inside the "Unlimited" trial (banner observed, 5 days left on 28 Nov), so plan-gated features were usable, but not their behaviour after the trial. Enterprise+ services were not seen. Locked items are listed in section 1.
- **No paired screen.** No player was paired, so screenshots, live status values, takeover, remote commands and hardware-player settings were read from forms, menus and help text, not exercised.
- **Nothing that changes data.** No save, push, upload, invite, purchase, takeover or AI generation. The playback-report form was filled but not saved. The add-screen flow was followed to the code entry step, and no code was entered. The in-app support chat opened once from an app-suggestion link and was closed without sending. Product tours were not started.
- **Checked afterwards.** After the run, no playlist, layout, app, media item or screen showed a change dated 28 Nov, the schedule list was still empty, and the counts on the settings page (users, groups, workspaces, roles, tags, fonts, alerts) matched the start of the session.
- **No third-party accounts.** Cloud drives, social, BI, calendar and design-tool apps were seen only as editor forms.
- **Hidden or markup-only controls**: the notification panel, a review-incentive banner, the dashboard emergency widget, a hardware-shipping widget, the subtitles switch, bulk user actions and the hidden schedules table. The emergency broadcast control was not found at all.
- **Documentation limits.** One research pass parsed the pricing table's plan marks from the page HTML; another could not read them. Yodeck's pages contradict each other on the trial's plan, Enterprise+ support hours, the Embeddable Feeds price unit and the Black Friday offer's plan. Not published anywhere found: the AI layout allowance, an Okta SCIM attribute list, a SOC 2 report. Only the first 100,000 characters of the API specification were re-read. Two pages were not reachable (a help article returned 404; the Black Friday page moved).

On the TINNOX side:

- **Read only; nothing was run.** "Built" means built and tested in development. Production is not deployed (CMS-37) and sends no alert e-mail (CMS-35).
- **Branch.** Rows were read at commit `d67d915`. Main then gained one change, screen deletion (CMS-41, PR #54), which the verifier checked on main. The proposed player plan revision DEC-36 sits uncommitted elsewhere and was not read.
- **Second-hand results.** The Pi 5 results (refused persistent storage, power-cut wipes) come from status card notes on CMS-4 and CMS-42, not from evidence files.
- **Unverified pending runtime:** whether Cognito sends `auth_time` and honours `prompt=login`, its lockout defaults, the price of Cognito threat protection, worker throughput, and how fades and tickers look on real players.

Verifier drops worth knowing about (21 rows dropped in all):

- **Offline schedule export to USB.** Only a menu label was seen, and Yodeck documents USB only for reflashing. TINNOX's own site promises a "USB fallback for offline loading" (`docs/tinnox-context.md:114`, PROPOSED, in no spec or story). TINNOX should decide whether it stands.
- **Hardware-shipping widget.** Hidden in Yodeck. If TINNOX wants install tracking ("Track Your Project", Q-T12), ask under that question.
- **Notification centre.** Dropped in the shell as unreachable, kept from the account area as Missing, Low.
- **Theme choice.** Dropped in the account area as cosmetic, kept from the shell as Partial, Low.
- **Others:** duplicates (dashboard emergency widget, editor templates panel, schedule content picker, volume entries, weekly report alignment, save variants, tile actions, app detail dialog, nesting guard), cosmetics (greeting card, a media empty state, layout grid view, account user menu), shared limits (no nested schedules), and items that are not software (review-incentive prompts, paid design services). One more: past and upcoming event groups, which follow dated events.
- **"TINNOX ahead" claims dropped:** a separate media-delete permission (every role with write access also holds it), a keyboard-friendly media library (nothing to drag; screen-reader pass CMS-6 open), a playlist delete guard as a lead (Yodeck's behaviour not observed), and "a lapsed licence never blanks screens" (designed in DEC-26, not built).

Folded rows where verifiers disagreed. Forty-one passed rows were folded into the row kept; most agreed. These did not:

| Kept row (area) | Folded row and its rating | Kept rating and why |
|---|---|---|
| Self-service password and authenticator reset (account) | Profile password: Partial, Medium | Planned, High. The kept row includes reset, which is backlog A3. |
| Customer off-boarding and deletion (account) | Profile account deletion: Planned, Medium | Planned, High. A purge path is a stage 1 gate. |
| Connected apps (account) | Profile connected apps: Planned, Low | Missing, Low. J1 plans service tokens, not per-user grants. |
| Alert types per screen (schedules) | Screens: Planned, Medium (as part of CMS-14) | Missing, Low. CMS-14 does not name it. |
| Layout inside a playlist or schedule (layouts) | Playlists: Missing, Low | Missing, Medium. The kept row also covers schedules. |
| Encrypted media on the player (screens) | Account: Planned, Medium | Missing, Medium. The CMS-42 note says "consider", not a plan. |
| Help and support link (shell) | Account help hub: Planned, Medium (J2) | Missing, Medium. J2 plans documentation, not a portal link. |
| Workspaces (account) | Shell selector: Planned, Medium; media and schedules: Planned, Low | Planned, Medium. |
| Screen takeover (screens) | Media: Planned, Medium; schedules: Planned, High | Planned, High. Docs and portal text disagree on working hours (row note). |
| Several ranges per day and special working hours (screens) | Schedules combined row: Partial, Medium | Kept split: two Partial, Low rows and one Missing, Medium row. |
| Guided product tours (shell) | Playlist tour and layout-editor tour: each Missing, Low | Partial, Low. The setup checklist covers first use; there are no tours anywhere. |
| What a screen can show (screens) | Media and apps "set to screen": each Missing, Low | Partial, Low. A screen takes a playlist, schedule or layout; a single item still needs a one-item playlist. |
| Weekly availability slots (media) | Playlists item availability: Partial, Medium | Planned, Medium. The from-until window is built (media parity row); weekly slots are planned (spec 6.4, D1). |
| Cookie preferences (shell, out of scope) | Account profile privacy (newsletter, cookies, deleting your own profile): Out of scope | Out of scope for cookies (D18) and own-profile deletion (D7). Newsletter consent stays Missing, Low in the shell: no decision excludes it. |

## 8. Sources

Yodeck documentation:

- Pricing and plans: https://www.yodeck.com/pricing/, https://www.yodeck.com/features-list/, https://www.yodeck.com/enterprise/, https://www.yodeck.com/digital-signage/enterprise-and-plus/, https://help.yodeck.com/en/articles/543957-yodeck-pricing-update-2026, https://www.yodeck.com/black-friday-2026-terms-and-conditions-new/
- Trial: https://help.yodeck.com/en/articles/589475, https://www.yodeck.com/docs/user-manual/free-period/
- SLA, security and support: https://www.yodeck.com/yodeck-service-level-agreement/, https://www.yodeck.com/digital-signage-security, https://www.yodeck.com/subprocessors, https://help.yodeck.com/en/articles/178348-what-about-customer-support
- API and AI agent: https://www.yodeck.com/features/yodeck-api/, https://app.yodeck.com/api-docs/bundle.yaml, https://www.yodeck.com/docs/user-manual/yodeck-mcp-installation-guide/
- Accounts: https://www.yodeck.com/docs/user-manual/how-to-configure-scim-with-azure-directory-entraid/, https://www.yodeck.com/docs/user-manual/yodeck-partner-network-faq/, https://www.yodeck.com/docs/user-manual/install-yodeck-portal-pwa/
- Content and layouts: https://www.yodeck.com/apps/, https://www.yodeck.com/docs/user-manual/magic-layout-design-layouts-with-ai/, https://www.yodeck.com/docs/user-manual/magic-write-ai-copywriting-digital-signage/, https://www.yodeck.com/docs/user-manual/locking-elements-controlling-access-layout-editor/, https://www.yodeck.com/docs/user-manual/content-flow-setup-guide/, https://www.yodeck.com/docs/user-manual/interactive-playlist/, https://www.yodeck.com/docs/user-manual/tv-source-widget/, https://www.yodeck.com/docs/user-manual/embeddable-feeds/, https://help.yodeck.com/en/articles/456275-counting-embeddable-feeds-views
- Interactive and solutions: https://help.yodeck.com/en/articles/456324-interactive-kiosk-introduction, https://help.yodeck.com/en/articles/456353-interactive-library, https://www.yodeck.com/solutions/wayfinding-digital-signage/, https://www.yodeck.com/solutions/touchscreen
- Alerts, schedules and reports: https://www.yodeck.com/docs/user-manual/emergency-alerts-introduction/, https://help.yodeck.com/en/articles/455960-national-weather-service-alerts, https://help.yodeck.com/en/articles/455848-volume-schedules, https://help.yodeck.com/en/articles/455928-playback-reports
- Hardware: https://help.yodeck.com/en/articles/628910-how-do-i-choose-between-the-1gb-and-4gb-yodeck-players-and-how-do-i-upgrade
- Release notes: https://www.yodeck.com/release-notes/check-out-december-2026s-digital-signage-updates/, https://www.yodeck.com/release-notes/check-out-november-2026s-digital-signage-updates/, https://www.yodeck.com/release-notes/check-out-october-2026s-digital-signage-updates/, https://www.yodeck.com/release-notes/check-out-september-2026s-digital-signage-updates/, https://www.yodeck.com/release-notes/check-out-february-2026-digital-signage-updates/, https://www.yodeck.com/release-notes/yodeck-updates-may-2026/, https://www.yodeck.com/release-notes/yodeck-updates-december-2025/, https://www.yodeck.com/release-notes/yodeck-updates-november-2025, https://www.yodeck.com/release-notes/yodeck-updates-september-2025/, https://www.yodeck.com/release-notes/yodeck-updates-april-2025/

TINNOX documents referenced:

- Earlier Yodeck work: `docs/yodeck-workflow-audit.md`, `docs/yodeck-ui-observation.md`, `docs/research/round2/AV1-accounts-admin.md`, `docs/research/round2/AV2-registration-api.md`, `docs/research/round2/AV3-media-playlists.md`
- Decisions and plans: `docs/decisions-2026-11.md`, `docs/implementation-backlog.md`, `docs/tinnox-mvp-spec.md`, `docs/tinnox-context.md`, `docs/deployment-plan-2026-11-24.md`, `docs/acceptance-tests.md`, `docs/prototype-m0.md`, `docs/player-protocol-v1.md`
- Portal v2: `docs/portal-v2/README.md`, `docs/portal-v2/design-system.md`, `docs/portal-v2/stage-a.md`, `docs/portal-v2/stage-b.md`, `docs/portal-v2/stage-c.md`, `docs/portal-v2/stage-c-roles-decision.md`, `docs/portal-v2/stage-c-alerts.md`
- Security: `docs/security/control-matrix.md`, `docs/security/threat-model.md`, `docs/security/operations-and-release-checklist.md`
- Player: `apps/player-web/README.md`
- Status cards (via `status show` and `status card`): CMS-3, CMS-4, CMS-6, CMS-14, CMS-16, CMS-17, CMS-18, CMS-20, CMS-27, CMS-35, CMS-36, CMS-37, CMS-38, CMS-41, CMS-42
