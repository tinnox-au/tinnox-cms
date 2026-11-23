/**
 * The helpers a read handler calls take the read-only handle (SCR-34; adoption plan step 20):
 * an `OrgReadTx`, which the callback of readOrg receives and which every `OrgTx` is too, so a
 * read can move to readOrg and a change can still call the same helper. A helper that locks or
 * writes keeps `OrgTx`. Nothing here runs: these lines are for `npm run typecheck`, where an
 * unused @ts-expect-error is an error. The helpers that are private to a route file (loadApp,
 * loadLayouts, loadScheduleDto, loadPlaylistDto, loadFolder, loadTag, loadDisplay,
 * loadMediaRow) are held by the type checker where their read handlers call them.
 */
import { readOrg, type OrgReadTx, type OrgTx, type Pool } from '@tinnox/db';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { ORG } from './change.test-support.ts';
import type { AppContext } from './context.ts';
import { loadStatusViews } from './display-state.ts';
import { usedBytes } from './media/rows.ts';
import {
  assessDisplays,
  createPublication,
  findPublicationByKey,
  loadAppRecords,
  loadLayoutDrafts,
  loadMediaRecords,
  loadPlaylistDrafts,
  loadPushPlan,
  loadScheduleDrafts,
  lockDisplayForPublish,
  lockPublishKey,
  type LockOn,
} from './publishing.ts';
import { replaceTags } from './tags.ts';

describe('the handle a read helper takes (SCR-34)', () => {
  it('is the read-only one, so readOrg can call it, and a change can too', () => {
    expectTypeOf(usedBytes).parameter(0).toEqualTypeOf<OrgReadTx>();
    expectTypeOf(loadStatusViews).parameter(0).toEqualTypeOf<OrgReadTx>();
    expectTypeOf(loadPushPlan).parameter(0).toEqualTypeOf<OrgReadTx>();
    expectTypeOf(findPublicationByKey).parameter(0).toEqualTypeOf<OrgReadTx>();
    const reads = async (pool: Pool, ctx: AppContext): Promise<void> => {
      await readOrg(pool, ORG, usedBytes);
      await readOrg(pool, ORG, (tx) => loadStatusViews(tx, ctx, null));
      await readOrg(pool, ORG, (tx) => loadPushPlan(tx, ctx));
      await readOrg(pool, ORG, (tx) => findPublicationByKey(tx, 'a-display-id', 'a-key'));
    };
    // Inside a change the same helpers take its handle.
    const inAChange = async (ctx: AppContext, write: OrgTx): Promise<void> => {
      await usedBytes(write);
      await loadStatusViews(write, ctx, null);
      await loadPushPlan(write, ctx);
    };
    expect([reads, inAChange]).toHaveLength(2);
  });

  it('may be asked to lock only inside a change: a row lock is refused in a read (25006)', () => {
    expectTypeOf<LockOn<OrgTx>>().toEqualTypeOf<boolean>();
    expectTypeOf<LockOn<OrgReadTx>>().toEqualTypeOf<false>();
    const cases = async (ctx: AppContext, read: OrgReadTx, write: OrgTx): Promise<void> => {
      await loadPlaylistDrafts(read, [], false);
      await loadScheduleDrafts(read, [], false);
      await loadLayoutDrafts(read, [], false);
      await loadMediaRecords(read, [], false);
      await loadAppRecords(read, [], false);
      await assessDisplays(read, ctx, [], { lock: false, keepDraft: false });
      // @ts-expect-error FOR SHARE on the playlists of a read-only transaction
      await loadPlaylistDrafts(read, [], true);
      // @ts-expect-error FOR SHARE on the schedules
      await loadScheduleDrafts(read, [], true);
      // @ts-expect-error FOR SHARE on the layouts
      await loadLayoutDrafts(read, [], true);
      // @ts-expect-error FOR KEY SHARE on the media
      await loadMediaRecords(read, [], true);
      // @ts-expect-error FOR KEY SHARE on the apps
      await loadAppRecords(read, [], true);
      // @ts-expect-error and all of them at once, as a push holds what it publishes
      await assessDisplays(read, ctx, [], { lock: true, keepDraft: true });
      // A change locks what it reads, or not.
      await loadPlaylistDrafts(write, [], true);
      await loadMediaRecords(write, [], false);
      await assessDisplays(write, ctx, [], { lock: true, keepDraft: true });
    };
    expect(cases).toBeTypeOf('function');
  });

  it('is the one that writes for a helper that locks or writes', () => {
    expectTypeOf(lockPublishKey).parameter(0).toEqualTypeOf<OrgTx>();
    expectTypeOf(lockDisplayForPublish).parameter(0).toEqualTypeOf<OrgTx>();
    expectTypeOf(createPublication).parameter(0).toEqualTypeOf<OrgTx>();
    expectTypeOf(replaceTags).parameter(0).toEqualTypeOf<OrgTx>();
    const cases = async (pool: Pool): Promise<void> => {
      // @ts-expect-error an advisory lock for a publication belongs to the change that publishes
      await readOrg(pool, ORG, (tx) => lockPublishKey(tx, 'a-display-id', 'a-key'));
      // @ts-expect-error FOR NO KEY UPDATE on the display
      await readOrg(pool, ORG, (tx) => lockDisplayForPublish(tx, 'a-display-id'));
      // @ts-expect-error a DELETE and an INSERT of tag links
      await readOrg(pool, ORG, (tx) => replaceTags(tx, 'media', 'a-media-id', []));
    };
    expect(cases).toBeTypeOf('function');
  });
});
