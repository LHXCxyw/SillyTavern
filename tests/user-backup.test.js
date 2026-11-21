/* global globalThis */
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import express from 'express';
import compression from 'compression';
import { unzipSync } from 'fflate';
import { abortUserOperations, setUserPurgeDeadline, waitForUserOperations } from '../src/user-operation-state.js';

const accounts = new Map();
const config = new Map();
jest.unstable_mockModule('node-persist', () => ({ default: { getItem: async key => accounts.get(key) } }));
jest.unstable_mockModule('../src/util.js', () => ({
    getConfigValue: (key, fallback) => config.get(key) ?? fallback,
    generateTimestamp: () => 'test',
}));
jest.unstable_mockModule('../src/users.js', () => ({
    toKey: handle => handle,
    getUserDirectories: handle => ({ root: path.join(globalThis.DATA_ROOT, handle) }),
}));
jest.unstable_mockModule('../src/endpoints/secrets.js', () => ({ allowKeysExposure: false, SECRETS_FILE: 'secrets.json' }));

const { initUserBackupJobs, stopUserBackupJobs, removeUserBackupJobs } = await import('../src/user-backup-jobs.js');
const { default: router } = await import('../src/endpoints/user-backup.js');
let server;
let base;
let root;

beforeEach(async () => {
    accounts.clear();
    for (const handle of ['alice', 'bob']) {
        accounts.set(handle, { handle, accountId: `${handle}-id`, enabled: true, admin: handle === 'alice' });
        setUserPurgeDeadline(handle, null);
    }
    config.clear();
    config.set('enableUserAccounts', true);
    config.set('backups.fullData.minFreeBytes', 0);
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'st-user-backup-')));
    globalThis.DATA_ROOT = root;
    await fs.mkdir(path.join(root, 'bob', 'backups'), { recursive: true });
    await fs.writeFile(path.join(root, 'bob', '.profile'), '数据');
    await fs.writeFile(path.join(root, 'bob', 'secrets.json'), '隐藏');
    await fs.writeFile(path.join(root, 'bob', 'backups', 'secrets_migration_old.json'), '隐藏');
    await initUserBackupJobs();
    const app = express();
    app.use(compression({ threshold: 0 }));
    app.use(express.json());
    app.use((request, response, next) => {
        request.user = { profile: accounts.get(request.get('X-Test-User') ?? 'alice') };
        next();
    });
    app.use('/api/users', router);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}/api/users/backup`;
});

afterEach(async () => {
    await stopUserBackupJobs();
    if (server) await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
    delete globalThis.DATA_ROOT;
});

function create(handle = 'bob', suffix = '/jobs', user = 'alice') {
    return fetch(`${base}${suffix}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Test-User': user }, body: JSON.stringify({ handle }),
    });
}

async function ready(handle = 'bob', user = 'alice') {
    const accepted = await create(handle, '/jobs', user);
    expect(accepted.status).toBe(202);
    const { id } = await accepted.json();
    const url = `${base}/jobs/${id}`;
    for (let index = 0; index < 100; index++) {
        const model = await (await fetch(url, { headers: { 'X-Test-User': user } })).json();
        if (model.state === 'ready') return { id, url, file: `${url}/file`, size: model.size };
        if (model.state === 'failed') throw new Error(model.error);
        await sleep(15);
    }
    throw new Error('备份未在测试时限内完成');
}

test('完整 ZIP 原子发布，重启后保留 ETag，支持 HEAD、Range 和 If-Range', async () => {
    const { file, size } = await ready();
    const full = await fetch(file);
    const etag = full.headers.get('etag');
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(full.headers.get('cache-control')).toContain('private, no-store');
    expect(full.headers.get('content-encoding')).toBe('identity');
    const zip = Buffer.from(await full.arrayBuffer());
    expect(Object.keys(unzipSync(zip)).sort()).toEqual(['.profile', 'backups/']);
    await stopUserBackupJobs();
    await initUserBackupJobs();
    const head = await fetch(file, { method: 'HEAD' });
    expect(head.headers.get('etag')).toBe(etag);
    expect(head.headers.get('content-length')).toBe(String(size));
    const range = await fetch(file, { headers: { Range: 'bytes=-8', 'If-Range': etag } });
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe(`bytes ${size - 8}-${size - 1}/${size}`);
    expect(Buffer.from(await range.arrayBuffer())).toEqual(zip.subarray(-8));
    const stale = await fetch(file, { headers: { Range: 'bytes=0-7', 'If-Range': `W/${etag}` } });
    expect(stale.status).toBe(200);
    expect(Buffer.from(await stale.arrayBuffer())).toEqual(zip);
    const invalid = await fetch(file, { headers: { Range: `bytes=${size}-` } });
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get('content-range')).toBe(`bytes */${size}`);
});

test('拒绝非所有者、降权发起人、替换后的目标及到期账号', async () => {
    const { url, file, id } = await ready();
    expect((await fetch(file, { headers: { 'X-Test-User': 'bob' } })).status).toBe(404);
    accounts.get('alice').admin = false;
    expect((await fetch(file)).status).toBe(403);
    accounts.get('alice').admin = true;
    accounts.get('bob').accountId = 'replacement';
    expect((await fetch(url)).status).toBe(403);
    accounts.get('bob').accountId = 'bob-id';
    setUserPurgeDeadline('alice', Date.now() - 1);
    expect([404, 410]).toContain((await fetch(file)).status);
    await removeUserBackupJobs('alice', 'alice-id');
    await expect(fs.stat(path.join(root, '_backup-downloads', `${id}.zip`))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('发起人的操作中止同步切断下载，清理等待文件关闭', async () => {
    await fs.writeFile(path.join(root, 'bob', 'large.bin'), randomBytes(768 * 1024));
    const { file, id } = await ready();
    const download = await fetch(file);
    const reader = download.body.getReader();
    expect((await reader.read()).done).toBe(false);
    setUserPurgeDeadline('alice', Date.now() - 1);
    abortUserOperations('alice');
    await expect((async () => { while (!(await reader.read()).done) { /* 等待连接关闭 */ } })()).rejects.toThrow();
    expect(await waitForUserOperations('bob', 1000)).toBe(true);
    await removeUserBackupJobs('alice', 'alice-id');
    await expect(fs.stat(path.join(root, '_backup-downloads', `${id}.zip`))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('拒绝账号目录内指向根外的目录链接，不留下部分 ZIP', async () => {
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(root, 'bob', 'foreign'), 'junction');
    await expect(ready()).rejects.toThrow('Unsafe backup path');
    expect(await fs.readdir(path.join(root, '_backup-downloads'))).toEqual([]);
});

test('下调限额后重启不会恢复超额 ZIP', async () => {
    const { file, size } = await ready();
    await stopUserBackupJobs();
    config.set('backups.fullData.maxArchiveBytes', size - 1);
    await initUserBackupJobs();
    expect((await fetch(file)).status).toBe(404);
    expect(await fs.readdir(path.join(root, '_backup-downloads'))).toEqual([]);
});

test('未启用账户时默认账号仍能使用旧版直流与备份任务', async () => {
    config.set('enableUserAccounts', false);
    accounts.set('default-user', { handle: 'default-user', enabled: true, admin: true });
    await fs.mkdir(path.join(root, 'default-user'));
    await fs.writeFile(path.join(root, 'default-user', 'settings.json'), '{}');
    const legacy = await create('default-user', '', 'default-user');
    expect(legacy.status).toBe(200);
    expect(Object.keys(unzipSync(new Uint8Array(await legacy.arrayBuffer())))).toEqual(['settings.json']);
    expect((await ready('default-user', 'default-user')).size).toBeGreaterThan(0);
});
