/**
 * Register of the columns that hold a membership id, read by catalogue.integration.test.ts,
 * which derives the columns from the migrated schema (foreign keys to `membership`, and columns
 * with "membership" in their name, which need no foreign key) and fails on one without an entry
 * (RCX-01). An entry says what the column lets happen on the member's behalf, and how that ends
 * when the member is removed, reactivated, or has their sessions ended (the cut-off,
 * `membership.sessions_valid_after`).
 *
 * Not seen by the derivation: a text column that holds a member id by convention only
 * (`audit_event.actor_id`, a record).
 */
export interface MemberReference {
  /**
   * - `revoked`: ended at once by the change that ends the member's sessions.
   * - `cut-off`: checked where the pending thing is used, against the member row and its cut-off.
   * - `cut-off at confirmation`: as `cut-off`, for an alert address (D22).
   * - `cancelled on removal`: closed by the change that removes or demotes the member.
   * - `record only`: says who did something; authorises nothing afterwards.
   */
  readonly closes:
    'revoked' | 'cut-off' | 'cut-off at confirmation' | 'cancelled on removal' | 'record only';
  readonly how: string;
}

/** Keyed by schema, table and column. */
export const MEMBER_REFERENCES: Readonly<Record<string, MemberReference>> = {
  'public.alert_recipient.created_by': {
    closes: 'cut-off at confirmation',
    how: 'Decision D22: confirming a pending address, and showing it as waiting, require that the member who added it is still active and that the address is newer than their cut-off; an address with no recorded adder is dead, and a reactivation keeps the cut-off. Confirmed addresses stay. The predicate belongs to apps/api/src/routes/alert-recipients.ts and is step 6a of docs/coding_guide/poteto_pyramid/adoption-plan.md: until that step lands, a pending address and its link outlive the member.',
  },
  'public.media.created_by': {
    closes: 'record only',
    how: 'Who uploaded the item. It belongs to the organisation and stays when the member goes.',
  },
  'public.member_invite.closed_by': {
    closes: 'record only',
    how: 'Who cancelled the invite; set as the invite closes, and a closed invite never changes (member_invite_guard).',
  },
  'public.member_invite.fulfilled_membership_id': {
    closes: 'record only',
    how: 'The member the invite became; set as the invite closes. That member is governed by their own row.',
  },
  'public.member_invite.invited_by': {
    closes: 'cancelled on removal',
    how: 'Removing the member cancels every pending invite they sent, and demoting them cancels those for a role they can no longer give, in the same transaction (cancelInvitesOf in apps/api/src/routes/members.ts, and the owner recovery in scripts/lib/provision.ts). provision-member fulfil checks the inviter again and refuses when they are removed or can no longer give the role. A cancelled invite is closed for good, so a reactivation brings none back. Ending the sessions of a member who keeps their role (sign out everywhere, MFA reset, the incident script) leaves their invites pending.',
  },
  'public.membership.removed_by': {
    closes: 'record only',
    how: 'Who removed the member. A removal is final for the API (membership_guard), whoever did it.',
  },
  'public.pairing_claim_failure.membership_id': {
    closes: 'record only',
    how: "A count of the member's wrong pairing codes, kept for a day to throttle guessing. It only ever refuses a claim, and sec.pairing_claim refuses a removed member before it counts.",
  },
  'public.pairing_session.claimed_by_membership': {
    closes: 'cut-off',
    how: 'sec.pairing_complete hands out the device credential only while the member who claimed the code is active and the claim is later than their cut-off (0013, RCX-01). Removal, demotion, sign out everywhere, MFA reset, owner recovery and the incident script all set the cut-off, and a reactivation keeps it, so a claim from before stays dead.',
  },
  'public.publication.created_by': {
    closes: 'record only',
    how: "Who published. A publication is the organisation's content and stays live when the member goes.",
  },
  'public.session.membership_id': {
    closes: 'revoked',
    how: 'sec.session_revoke_membership ends the live sessions and sets the cut-off; sec.session_by_id_hash refuses a session of a removed member or from before the cut-off, and sec.session_create refuses a sign-in authenticated before it. A reactivation keeps the cut-off.',
  },
};
