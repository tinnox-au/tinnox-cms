/** The e-mail texts of the alert check (docs/portal-v2/stage-c-alerts.md section 5). */
import { describe, expect, it } from 'vitest';
import { confirmationEmail, offlineEmail, onlineEmail, siteTime } from './alerts.ts';

const screen = {
  id: '00000000-0000-4000-8000-000000000003',
  name: 'Foyer wall',
  site_name: 'Head office',
  timezone: 'Australia/Melbourne',
  orgName: 'Acme Pty Ltd',
  portalOrigin: 'https://portal.example',
};
const at = new Date('2026-11-21T04:04:00Z');
const footer =
  'You receive this because this address is on the alert list of Acme Pty Ltd in TINNOX CMS. ' +
  'To stop, ask an Admin of that organisation to remove it.';

describe('alert e-mails', () => {
  it("gives times in the site's zone, and UTC for an unknown zone", () => {
    expect(siteTime(at, 'Australia/Melbourne')).toBe('21 Nov 2026, 3:04 pm (Australia/Melbourne)');
    expect(siteTime(at, 'Mars/Olympus_Mons')).toBe('2026-11-21T04:04:00.000Z');
  });

  it('names the screen, site, organisation, last report and delay when it stops reporting', () => {
    const mail = offlineEmail(screen, at, 60);
    expect(mail.subject).toBe('Screen not reporting: Foyer wall');
    expect(mail.text).toContain('Site: Head office');
    expect(mail.text).toContain('Organisation: Acme Pty Ltd');
    expect(mail.text).toContain('Last report: 21 Nov 2026, 3:04 pm (Australia/Melbourne)');
    expect(mail.text).toContain('the screen has not reported for 1 hour.');
    expect(mail.text).toContain(`https://portal.example/screens/${screen.id}`);
    expect(mail.text).toContain(footer);
  });

  it('says when it reports again', () => {
    const mail = onlineEmail(screen, at);
    expect(mail.subject).toBe('Screen reporting again: Foyer wall');
    expect(mail.text).toContain('Reported again: 21 Nov 2026, 3:04 pm (Australia/Melbourne)');
    expect(mail.text).toContain(footer);
  });

  it('never says online or offline', () => {
    for (const mail of [offlineEmail(screen, at, 30), onlineEmail(screen, at)])
      expect(`${mail.subject} ${mail.text}`).not.toMatch(/online|offline/i);
  });

  // D23: these are the whole messages, written out by hand, so a new field (another fact about the
  // screen, a member's name, an HTML part) fails here and is reviewed against DEC-13 and T12 of
  // docs/security/threat-model.md section 15 before it reaches a mail provider.
  it('D23: the e-mail when a screen stops reporting is exactly this', () => {
    expect(offlineEmail(screen, at, 60)).toStrictEqual({
      subject: 'Screen not reporting: Foyer wall',
      text: [
        'Screen: Foyer wall',
        'Site: Head office',
        'Organisation: Acme Pty Ltd',
        'Last report: 21 Nov 2026, 3:04 pm (Australia/Melbourne)',
        '',
        'This alert was sent because the screen has not reported for 1 hour.',
        '',
        'Open the screen: https://portal.example/screens/00000000-0000-4000-8000-000000000003',
        '',
        'You receive this because this address is on the alert list of Acme Pty Ltd in TINNOX CMS. To stop, ask an Admin of that organisation to remove it.',
        '',
      ].join('\n'),
    });
  });

  it('D23: the e-mail when a screen reports again is exactly this', () => {
    expect(onlineEmail(screen, at)).toStrictEqual({
      subject: 'Screen reporting again: Foyer wall',
      text: [
        'Screen: Foyer wall',
        'Site: Head office',
        'Reported again: 21 Nov 2026, 3:04 pm (Australia/Melbourne)',
        '',
        'Open the screen: https://portal.example/screens/00000000-0000-4000-8000-000000000003',
        '',
        'You receive this because this address is on the alert list of Acme Pty Ltd in TINNOX CMS. To stop, ask an Admin of that organisation to remove it.',
        '',
      ].join('\n'),
    });
  });

  it('D23: the confirmation e-mail is exactly this', () => {
    expect(confirmationEmail('Acme Pty Ltd', 'https://portal.example', 'TOKEN', 7)).toStrictEqual({
      subject: 'Confirm alert e-mails from TINNOX CMS',
      text: [
        'Acme Pty Ltd asked to send screen alerts to this address. To agree, open this link within 7 days:',
        '',
        'https://portal.example/alerts/confirm#TOKEN',
        '',
        'If you did not expect this, ignore this e-mail and nothing more will be sent.',
        '',
      ].join('\n'),
    });
  });

  it('puts the confirmation token in the fragment and names nobody who added it', () => {
    const mail = confirmationEmail('Acme Pty Ltd', 'https://portal.example', 'TOKEN', 7);
    expect(mail.subject).toBe('Confirm alert e-mails from TINNOX CMS');
    expect(mail.text).toContain('Acme Pty Ltd asked to send screen alerts to this address.');
    expect(mail.text).toContain('within 7 days');
    expect(mail.text).toContain('https://portal.example/alerts/confirm#TOKEN');
    expect(mail.text).toContain('ignore this e-mail and nothing more will be sent');
  });
});
