import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createTransport, sendMail } = vi.hoisted(() => {
  const sendMail = vi.fn(() => Promise.resolve({}));
  return { sendMail, createTransport: vi.fn((_options: unknown) => ({ sendMail })) };
});
vi.mock('nodemailer', () => ({ createTransport }));

const { createMailer } = await import('./mail.ts');

const base = { port: 587, secure: false, user: null, password: null, from: 'alerts@example.com' };

describe('createMailer', () => {
  beforeEach(() => createTransport.mockClear());

  it('is null without SMTP settings', () => {
    expect(createMailer(null)).toBeNull();
  });

  it('requires TLS to any host but a loopback address', () => {
    createMailer({ ...base, host: 'smtp.example.com' });
    createMailer({ ...base, host: '127.0.0.1' });
    createMailer({ ...base, host: '::1' });
    // Every spelling of ::1 is the same address, so the shared rule exempts it too; before it,
    // mail.ts compared with the bare '::1' only (EAX-08, a deliberate widening: no name is added).
    createMailer({ ...base, host: '[::1]' });
    createMailer({ ...base, host: '0:0::1' });
    createMailer({ ...base, host: '0000:0000:0000:0000:0000:0000:0000:0001' });
    // Names go through DNS, which may answer with another machine.
    createMailer({ ...base, host: 'localhost' });
    createMailer({ ...base, host: 'relay.localhost' });
    // Only 127.0.0.1 is loopback, as before the shared rule (EAX-08).
    createMailer({ ...base, host: '127.0.0.2' });
    createMailer({ ...base, host: 'smtp.example.com', port: 465, secure: true });
    expect(createTransport.mock.calls.map(([options]) => options)).toMatchObject([
      { host: 'smtp.example.com', requireTLS: true },
      { host: '127.0.0.1', requireTLS: false },
      { host: '::1', requireTLS: false },
      { host: '[::1]', requireTLS: false },
      { host: '0:0::1', requireTLS: false },
      { host: '0000:0000:0000:0000:0000:0000:0000:0001', requireTLS: false },
      { host: 'localhost', requireTLS: true },
      { host: 'relay.localhost', requireTLS: true },
      { host: '127.0.0.2', requireTLS: true },
      { host: 'smtp.example.com', secure: true, requireTLS: false },
    ]);
  });

  it('sends plain text from MAIL_FROM, with credentials only when given', async () => {
    const mailer = createMailer({ ...base, host: 'smtp.example.com', user: 'u', password: 'p' });
    await mailer?.send({ to: 'ops@example.com', subject: 'S', text: 'T' });
    expect(createTransport.mock.calls[0]?.[0]).toMatchObject({ auth: { user: 'u', pass: 'p' } });
    expect(sendMail).toHaveBeenCalledWith({
      from: 'alerts@example.com',
      to: 'ops@example.com',
      subject: 'S',
      text: 'T',
    });
  });
});
