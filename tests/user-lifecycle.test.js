import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';

jest.unstable_mockModule('../src/users.js', () => ({ toKey: handle => `user:${handle}` }));
const { createUserLifecycle } = await import('../src/user-lifecycle.js');
const { acquireUserOperation, getUserPurgeDeadline, isUserPurgeBlocked, setUserPurgeDeadline } = await import('../src/user-operation-state.js');

const retention = 168 * 3_600_000;
const actor = { handle: 'operator', accountId: 'operator-id' };
const email = 'alice@example.test';
let root, users, time, paused, sendNotice, sendCancellationNotice, purgeUser, service;

function init() {
    return createUserLifecycle({
        dataRoot: root, now: () => time, paused: () => paused, sendNotice, sendCancellationNotice, purgeUser,
        readUser: async handle => users.get(handle),
        writeUser: async user => users.set(user.handle, user),
        drainTimeoutMs: 5,
    });
}

async function schedule(handle = 'alice') {
    const { previewId } = await service.preview([handle], actor);
    const result = await service.confirm(previewId, actor);
    expect(result.items[0].ok).toBe(true);
    return { ...result.items[0], previewId };
}

function jobFile(jobId) {
    return path.join(root, '_user-lifecycle', `${jobId}.json`);
}

async function saved(jobId) {
    return JSON.parse(await fs.readFile(jobFile(jobId), 'utf8'));
}

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'user-lifecycle-test-'));
    time = Date.now();
    paused = false;
    users = new Map([
        ['alice', { handle: 'alice', accountId: 'alice-id', email, enabled: true }],
        ['bob', { handle: 'bob', accountId: 'bob-id', enabled: false }],
        ['operator', { ...actor, admin: true }],
        ['admin', { handle: 'admin', accountId: 'admin-id', admin: true }],
    ]);
    sendNotice = jest.fn(async () => ({ acceptedAt: time }));
    sendCancellationNotice = jest.fn(async () => ({ acceptedAt: time }));
    purgeUser = jest.fn(async job => { users.delete(job.handle); });
    service = await init();
});

afterEach(async () => {
    service.stop();
    for (const handle of ['alice', 'bob', 'admin', 'operator']) setUserPurgeDeadline(handle, null);
    await fs.rm(root, { recursive: true, force: true });
});

test('批量确认逐项保护账户；并发确认保持幂等，缺邮箱不开始倒计时', async () => {
    const preview = await service.preview(['alice', 'bob', 'operator', 'admin', 'default-user', 'missing'], actor);
    expect(preview.retentionHours).toBe(168);
    expect(preview.items.map(row => row.eligible)).toEqual([true, true, false, false, false, false]);
    expect(preview.items[1].reason).toMatch(/不会开始倒计时/);
    await expect(service.confirm(preview.previewId, { handle: 'admin', accountId: 'admin-id' })).rejects.toMatchObject({ status: 403 });
    const a = service.confirm(preview.previewId, actor);
    const b = service.confirm(preview.previewId, actor);
    const [first, second] = await Promise.all([a, b]);
    expect(first).toEqual(second);
    expect(first.items.map(row => row.ok)).toEqual([true, true, false, false, false, false]);
    await service.runOnce();
    expect(sendNotice).toHaveBeenCalledTimes(1);
    expect(service.getRemoval('bob')).toEqual({ state: 'blocked', purgeAt: null });
    expect(users.get('bob').enabled).toBe(false);
    expect(JSON.stringify(service.list())).not.toContain(email);
    service = await init();
    expect(await service.confirm(preview.previewId, actor)).toEqual(first);
    await expect(service.confirm(preview.previewId, { handle: 'admin', accountId: 'admin-id' })).rejects.toMatchObject({ status: 403 });
});

test('SMTP 明确接受后保留完整 168 小时；到期中止操作并等待排空', async () => {
    const { jobId, previewId } = await schedule();
    time += 5000;
    await service.runOnce();
    const acceptance = time;
    expect(await saved(jobId)).toMatchObject({ state: 'grace', acceptedAt: acceptance, purgeAt: acceptance + retention });
    expect(users.get('alice').enabled).toBe(true);
    service = await init();
    expect((await service.confirm(previewId, actor)).items[0].jobId).toBe(jobId);
    expect(getUserPurgeDeadline('alice')).toBe(acceptance + retention);
    time += retention - 1;
    await service.runOnce();
    expect(purgeUser).not.toHaveBeenCalled();
    const onAbort = jest.fn();
    const release = acquireUserOperation('alice', { onAbort });
    time += 1;
    await expect(service.cancel(jobId, actor.accountId)).rejects.toMatchObject({ status: 409 });
    await service.runOnce();
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(isUserPurgeBlocked('alice')).toBe(true);
    expect(purgeUser).not.toHaveBeenCalled();
    release();
    time += 30_000;
    await service.runOnce();
    expect(purgeUser).toHaveBeenCalledWith({ id: jobId, handle: 'alice', accountId: 'alice-id' });
    expect(service.getRemoval('alice')).toBeNull();
    expect(await saved(jobId)).toMatchObject({ state: 'cleared', email: null });
});

test('撤销已发出通知的移除任务后发送取消通知', async () => {
    const { jobId } = await schedule();
    await service.runOnce();
    expect(sendNotice).toHaveBeenCalledTimes(1);
    expect(sendCancellationNotice).not.toHaveBeenCalled();

    const result = await service.cancel(jobId, actor.accountId);
    expect(result.state).toBe('cancelled');
    await new Promise(resolve => setImmediate(resolve));

    expect(sendCancellationNotice).toHaveBeenCalledWith({ email });
    expect(await saved(jobId)).toMatchObject({ state: 'cancelled', email: null });
});

test('撤销尚未发出通知的任务不发送取消通知', async () => {
    const { jobId } = await schedule();
    await service.cancel(jobId, actor.accountId);
    await new Promise(resolve => setImmediate(resolve));

    expect(sendCancellationNotice).not.toHaveBeenCalled();
});

test('邮箱更新先撤销；迟到的 SMTP 成功不会恢复任务', async () => {
    const { jobId } = await schedule();
    const started = Promise.withResolvers();
    const response = Promise.withResolvers();
    sendNotice.mockImplementation(() => { started.resolve(); return response.promise; });
    const work = service.runOnce();
    await started.promise;
    expect(await saved(jobId)).toMatchObject({ state: 'queued', sendingAt: time });
    await expect(service.changeEmail('alice', 'updated@example.test', actor.accountId)).resolves.toMatchObject({ removalCancelled: true });
    await expect(service.changeEmail('admin', email, actor.accountId)).rejects.toMatchObject({ status: 403 });
    response.resolve({ acceptedAt: time });
    await work;
    expect(await saved(jobId)).toMatchObject({ state: 'cancelled', email: null, acceptedAt: null, purgeAt: null });
    expect(getUserPurgeDeadline('alice')).toBeNull();
});

test('崩溃时发送中任务恢复为待处理，且邮箱漂移必须重新预览', async () => {
    const { jobId } = await schedule();
    const job = await saved(jobId);
    await fs.writeFile(jobFile(jobId), JSON.stringify({ ...job, attempts: 1, sendingAt: time }));
    service = await init();
    await service.runOnce();
    expect(sendNotice).not.toHaveBeenCalled();
    expect(await saved(jobId)).toMatchObject({ state: 'blocked', sendingAt: null, purgeAt: null });
    users.get('alice').email = 'changed@example.test';
    await expect(service.retry(jobId, actor.accountId)).rejects.toMatchObject({ status: 409 });
    users.get('alice').email = email;
    await service.retry(jobId, actor.accountId);
    await service.runOnce();
    expect(service.getRemoval('alice').state).toBe('grace');
});

test('明确临时失败有限退避，结果不明则停止自动重试', async () => {
    const { jobId } = await schedule();
    sendNotice.mockRejectedValue(Object.assign(new Error(), { retryable: true, uncertain: false }));
    await service.runOnce();
    time += 59_999;
    await service.runOnce();
    expect(sendNotice).toHaveBeenCalledTimes(1);
    time += 1;
    await service.runOnce();
    time += 300_000;
    await service.runOnce();
    expect(sendNotice).toHaveBeenCalledTimes(3);
    expect(await saved(jobId)).toMatchObject({ state: 'blocked', purgeAt: null });
    await service.retry(jobId, actor.accountId);
    sendNotice.mockRejectedValue(Object.assign(new Error(), { retryable: true, uncertain: true }));
    await service.runOnce();
    time += 600_000;
    await service.runOnce();
    expect(sendNotice).toHaveBeenCalledTimes(4);
    expect(await saved(jobId)).toMatchObject({ state: 'blocked', purgeAt: null });
});

test('维护期间仍封锁并中止到期操作，清理失败后从账号已消失状态可重入', async () => {
    const { jobId } = await schedule();
    await service.runOnce();
    const onAbort = jest.fn(() => release());
    const release = acquireUserOperation('alice', { onAbort });
    paused = true;
    time += retention;
    await service.runOnce();
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(isUserPurgeBlocked('alice')).toBe(true);
    expect(purgeUser).not.toHaveBeenCalled();
    paused = false;
    purgeUser.mockImplementationOnce(async () => { users.delete('alice'); throw new Error('模拟清理中断'); });
    await service.runOnce();
    expect(await saved(jobId)).toMatchObject({ state: 'purging' });
    service = await init();
    expect(isUserPurgeBlocked('alice')).toBe(true);
    time += 30_000;
    await service.runOnce();
    expect(await saved(jobId)).toMatchObject({ state: 'cleared' });
});

test('慢 SMTP 不阻塞其他账号到期，恢复遇到账号身份变化时拒绝启动', async () => {
    await schedule();
    await service.runOnce();
    users.get('bob').email = 'bob@example.test';
    await schedule('bob');
    const started = Promise.withResolvers();
    const response = Promise.withResolvers();
    sendNotice.mockImplementation(() => { started.resolve(); return response.promise; });
    const work = service.runOnce();
    await started.promise;
    const alice = users.get('alice');
    users.set('alice', { ...alice, accountId: 'replacement-id' });
    await expect(init()).rejects.toThrow('身份无法安全恢复');
    expect(purgeUser).not.toHaveBeenCalled();
    users.set('alice', alice);
    time += retention;
    await service.runOnce();
    expect(purgeUser).toHaveBeenCalledTimes(1);
    response.resolve({ acceptedAt: time });
    await work;
});

test('确认前换邮箱或重建账户使旧预览失效；损坏记录拒绝启动', async () => {
    const result = await service.preview(['alice', 'bob'], actor);
    users.get('alice').email = 'changed@example.test';
    users.get('bob').accountId = 'replacement-id';
    const confirmed = await service.confirm(result.previewId, actor);
    expect(confirmed.items.map(item => item.ok)).toEqual([false, false]);
    expect(service.list().total).toBe(0);
    const { jobId } = await schedule();
    await fs.writeFile(jobFile(jobId), '{');
    await expect(init()).rejects.toThrow('任务记录不可读取');
});
