#!/usr/bin/env node

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  acquireLease,
  readLease,
  renewLease,
  releaseLease,
} from '../server/services/lease-manager.js';

describe('Lease concurrency edge cases', () => {
  let tmpRoot;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-lease-edge-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true });
  });

  it('second acquirer fails when lease is active', async () => {
    const lease1 = await acquireLease(tmpRoot, {
      leaseId: 'lease-dual',
      jobId: 'job-1',
      phase: 'plan',
      ttlMs: 60_000,
    });
    assert.ok(lease1);

    await assert.rejects(
      () => acquireLease(tmpRoot, {
        leaseId: 'lease-dual',
        jobId: 'job-2',
        phase: 'plan',
        ttlMs: 60_000,
      }),
      { code: 'EEXIST' }
    );
  });

  it('second acquirer wins after lease expires', async () => {
    const lease1 = await acquireLease(tmpRoot, {
      leaseId: 'lease-expire',
      jobId: 'job-1',
      phase: 'plan',
      ttlMs: 50,
    });

    await new Promise((r) => setTimeout(r, 100));

    const lease2 = await acquireLease(tmpRoot, {
      leaseId: 'lease-expire',
      jobId: 'job-2',
      phase: 'plan',
      ttlMs: 60_000,
    });
    assert.equal(lease2.jobId, 'job-2');
    assert.notEqual(lease2.ownerToken, lease1.ownerToken);
  });

  it('renew with wrong ownerToken fails', async () => {
    await acquireLease(tmpRoot, {
      leaseId: 'lease-owner',
      jobId: 'job-1',
      phase: 'plan',
      ttlMs: 60_000,
    });

    await assert.rejects(
      () => renewLease(tmpRoot, 'lease-owner', {
        ttlMs: 60_000,
        ownerToken: 'wrong-token',
      }),
      /owner mismatch/
    );
  });

  it('renew with correct ownerToken succeeds', async () => {
    const lease = await acquireLease(tmpRoot, {
      leaseId: 'lease-renew',
      jobId: 'job-1',
      phase: 'plan',
      ttlMs: 60_000,
    });

    const renewed = await renewLease(tmpRoot, 'lease-renew', {
      ttlMs: 60_000,
      ownerToken: lease.ownerToken,
    });
    assert.ok(renewed.heartbeatAt);
  });

  it('release with wrong ownerToken fails', async () => {
    await acquireLease(tmpRoot, {
      leaseId: 'lease-release',
      jobId: 'job-1',
      phase: 'plan',
      ttlMs: 60_000,
    });

    await assert.rejects(
      () => releaseLease(tmpRoot, 'lease-release', {
        ownerToken: 'wrong-token',
      }),
      /owner mismatch/
    );
  });

  it('release with correct ownerToken succeeds', async () => {
    const lease = await acquireLease(tmpRoot, {
      leaseId: 'lease-release-ok',
      jobId: 'job-1',
      phase: 'plan',
      ttlMs: 60_000,
    });

    await releaseLease(tmpRoot, 'lease-release-ok', {
      ownerToken: lease.ownerToken,
    });

    const after = await readLease(tmpRoot, 'lease-release-ok');
    assert.equal(after, null);
  });

  it('renew on missing lease fails', async () => {
    await assert.rejects(
      () => renewLease(tmpRoot, 'lease-missing', { ttlMs: 60_000 }),
      /lease not found/
    );
  });

  it('ttlMs=0 results in immediately stale lease', async () => {
    const lease = await acquireLease(tmpRoot, {
      leaseId: 'lease-zero-ttl',
      jobId: 'job-1',
      phase: 'plan',
      ttlMs: 0,
    });

    const read = await readLease(tmpRoot, 'lease-zero-ttl');
    assert.ok(read);
    // Lease should be stale since ttlMs=0 means it expires immediately
    const { isLeaseStale } = await import('../server/services/lease-manager.js');
    assert.ok(isLeaseStale(read));
  });
});

import path from 'node:path';
