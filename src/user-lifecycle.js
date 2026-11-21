import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import storage from 'node-persist';
import writeFileAtomic from 'write-file-atomic';
import { DEFAULT_USER } from './constants.js';
import { normalizeNotificationAddress, sendAccountRemovalNotice } from './smtp-service.js';
import { toKey } from './users.js';
import { getConfigValue } from './util.js';
import { abortUserOperations, isUserPurgeBlocked, setUserPurgeDeadline, waitForUserOperations, withUserLock } from './user-operation-state.js';

const HOURS = 168;
const RETENTION = HOURS * 3_600_000;
const PREVIEW_TTL = 10 * 60_000;
const BACKOFF = [60_000, 300_000];
const PURGE_RETRY = 30_000;
const MAX_CONCURRENT_MAIL = 2;
const MAX_CONCURRENT_PURGE = 1;
const STATES = new Set(['queued', 'blocked', 'grace', 'purging', 'cleared', 'cancelled']);
const MISSING_EMAIL = '没有有效通知邮箱，不会开始倒计时。';
const UNCERTAIN = '无法确认 SMTP 是否接受通知，未开始倒计时。';
const STALE = '账户身份或邮箱已变化，请重新预览。';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const terminal = job => job.state === 'cleared' || job.state === 'cancelled';
const timed = job => job.state === 'grace' || job.state === 'purging';
const isText = value => typeof value === 'string' && value.length > 0;
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const emailValue = user => typeof user?.email === 'string' ? user.email : '';
const publicJob = ({ id, handle, state, reason, purgeAt, acceptedAt, createdAt }) => ({ id, handle, state, reason, purgeAt, acceptedAt, createdAt });

export function isRemovalHandle(value) {
    return typeof value === 'string' && /^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/i.test(value) && value.length <= 255;
}

export class UserRemovalError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

/** 创建独立的生命周期服务；生产环境通过下方的单例入口使用。 */
export async function createUserLifecycle({
    purgeUser,
    dataRoot = globalThis.DATA_ROOT,
    now = () => Date.now(),
    sendNotice = sendAccountRemovalNotice,
    paused = () => getConfigValue('userLifecycle.paused', false, 'boolean'),
    readUser = handle => storage.getItem(toKey(handle)),
    writeUser = user => storage.setItem(toKey(user.handle), user),
    drainTimeoutMs = 30_000,
} = {}) {
    if (typeof purgeUser !== 'function') throw new TypeError('必须提供可重入的账户清理回调。');
    const directory = path.join(dataRoot, '_user-lifecycle');
    const jobs = new Map();
    const active = new Map();
    const previews = new Map();
    const receipts = new Map();
    const workers = new Map();
    const aborted = new Set();
    let timer;
    let running = false;

    function index(job) {
        jobs.set(job.id, job);
        const key = job.handle.toLowerCase();
        if (!terminal(job)) {
            active.set(key, job);
            setUserPurgeDeadline(job.handle, job.state === 'purging' ? 0 : job.purgeAt);
        } else if (active.get(key)?.id === job.id) {
            active.delete(key);
            aborted.delete(job.id);
            setUserPurgeDeadline(job.handle, null);
        }
    }

    async function persist(job) {
        await writeFileAtomic(path.join(directory, `${job.id}.json`), JSON.stringify(job), { mode: 0o600 });
        index(job);
        return job;
    }

    function update(job, patch) {
        return persist({ ...job, ...patch, updatedAt: now() });
    }

    function finish(job, state, reason, actorId = null) {
        return update(job, { state, reason, email: null, sendingAt: null, nextAt: null, finishedAt: now(), finishedBy: actorId });
    }

    function identityMatches(job, user) {
        return user && user.handle === job.handle && user.accountId === job.accountId && !user.admin;
    }

    function validateRecord(job, filename) {
        const deadlineValid = timestamp(job?.acceptedAt) && job.acceptedAt >= job.createdAt
            && timestamp(job.purgeAt) && job.purgeAt === job.acceptedAt + RETENTION;
        if (job?.version !== 1 || !UUID.test(job.id) || filename !== `${job.id}.json`
            || !UUID.test(job.previewId) || !isText(job.accountId) || !isText(job.actorId) || job.actorId === job.accountId
            || !isRemovalHandle(job.handle) || job.handle.toLowerCase() === DEFAULT_USER.handle
            || !STATES.has(job.state) || !timestamp(job.createdAt) || !timestamp(job.updatedAt)
            || !Number.isSafeInteger(job.attempts) || job.attempts < 0 || job.attempts > BACKOFF.length + 1
            || !(job.sendingAt === null || (job.state === 'queued' && job.attempts > 0 && timestamp(job.sendingAt)))
            || !(job.nextAt === null || timestamp(job.nextAt))
            || (timed(job) || job.state === 'cleared' ? !deadlineValid : !(job.acceptedAt === null && job.purgeAt === null) && !(job.state === 'cancelled' && deadlineValid))
            || (terminal(job) ? job.email !== null : job.email !== null && normalizeNotificationAddress(job.email) !== job.email)
            || (job.state === 'queued' && (!job.email || job.nextAt === null))) {
            throw new Error(`延期清除任务记录无法安全恢复：${filename}`);
        }
    }

    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(directory)).isDirectory()) throw new Error('延期清除任务目录不是真实目录。');
    const records = [];
    const handles = new Set();
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        // 原子写中断留下的临时文件不是已提交记录；真实清理使用同级私有子目录。
        if (!entry.name.toLowerCase().endsWith('.json')) continue;
        if (!entry.isFile()) throw new Error('延期清除任务目录中存在非普通记录文件。');
        let job;
        try {
            job = JSON.parse(await fs.readFile(path.join(directory, entry.name), 'utf8'));
        } catch {
            throw new Error(`延期清除任务记录不可读取：${entry.name}`);
        }
        if (entry.name.startsWith('receipt-')) {
            const receipt = job;
            if (receipt?.version !== 1 || !UUID.test(receipt.previewId) || entry.name !== `receipt-${receipt.previewId}.json`
                || !isText(receipt.actorId) || !Array.isArray(receipt.items) || receipt.items.length < 1 || receipt.items.length > 100
                || !receipt.items.every(row => isRemovalHandle(row?.handle) && typeof row.ok === 'boolean'
                    && (row.reason === null || typeof row.reason === 'string')
                    && (!row.ok || (UUID.test(row.jobId) && STATES.has(row.state))))) {
                throw new Error(`延期清除确认回执无法安全恢复：${entry.name}`);
            }
            const items = receipt.items.map(({ handle, ok, jobId, state, reason }) => ok ? { handle, ok, jobId, state, reason } : { handle, ok, reason });
            receipts.set(receipt.previewId, { actorId: receipt.actorId, result: { items } });
            continue;
        }
        validateRecord(job, entry.name);
        if (!terminal(job)) {
            const key = job.handle.toLowerCase();
            if (handles.has(key)) throw new Error('同一用户名存在多个活动清除任务，无法安全恢复。');
            handles.add(key);
            if (timed(job)) {
                const user = await readUser(job.handle);
                if (!(job.state === 'purging' && user == null) && !identityMatches(job, user)) {
                    throw new Error(`延期清除任务身份无法安全恢复：${job.id}`);
                }
            }
        }
        records.push(job);
    }
    for (const job of records) index(job);
    for (const job of records) {
        if (job.sendingAt !== null) await update(job, { state: 'blocked', reason: UNCERTAIN, sendingAt: null, nextAt: null });
    }

    function protection(handle, user, actor) {
        if (handle.toLowerCase() === actor.handle.toLowerCase() || (user && user.accountId === actor.accountId)) return '不能清除自己的账户。';
        if (handle.toLowerCase() === DEFAULT_USER.handle || user?.admin) return '默认账户和管理员账户受保护。';
        if (!user || user.handle !== handle) return '账户不存在。';
        if (!isText(user.accountId)) return '账户缺少稳定身份，不能安排清除。';
        if (active.has(handle.toLowerCase()) || isUserPurgeBlocked(handle)) return '账户已有活动清除任务。';
        return null;
    }

    function prunePreviews() {
        for (const [id, preview] of previews) {
            if (!preview.pending && preview.expiresAt <= now()) previews.delete(id);
        }
    }

    async function preview(handlesToCheck, actor) {
        if (!Array.isArray(handlesToCheck) || handlesToCheck.length < 1 || handlesToCheck.length > 100
            || !handlesToCheck.every(isRemovalHandle)) throw new UserRemovalError(400, '请提供 1 至 100 个有效用户名。');
        prunePreviews();
        if (previews.size >= 1000) throw new UserRemovalError(429, '预览数量过多，请稍后再试。');
        const previewId = randomUUID();
        const expiresAt = now() + PREVIEW_TTL;
        const items = new Map();
        for (const handle of handlesToCheck) {
            if (!items.has(handle)) items.set(handle, withUserLock(handle, async () => {
                const user = await readUser(handle);
                const reason = protection(handle, user, actor);
                const rawEmail = emailValue(user);
                const email = normalizeNotificationAddress(rawEmail);
                return { handle, name: user?.name ?? handle, email, eligible: !reason, reason: reason ?? (email ? null : MISSING_EMAIL), accountId: user?.accountId, rawEmail };
            }));
        }
        const rows = await Promise.all(items.values());
        previews.set(previewId, { actorId: actor.accountId, expiresAt, rows, pending: null });
        return { previewId, expiresAt, retentionHours: HOURS, items: rows.map(({ handle, name, email, eligible, reason }) => ({ handle, name, email, eligible, reason })) };
    }

    const confirmationItem = (job) => ({ handle: job.handle, ok: true, jobId: job.id, state: job.state, reason: job.reason });

    async function confirm(previewId, actor) {
        if (typeof previewId !== 'string' || !UUID.test(previewId)) throw new UserRemovalError(400, '必须先预览再确认，不能直接清除账户。');
        prunePreviews();
        const entry = previews.get(previewId);
        const receipt = receipts.get(previewId);
        if ((entry ?? receipt) && (entry ?? receipt).actorId !== actor.accountId) throw new UserRemovalError(403, '不能确认其他管理员的预览。');
        if (receipt) return receipt.result;
        const prior = [...jobs.values()].filter(job => job.previewId === previewId && job.actorId === actor.accountId);
        if (!entry) {
            if (prior.length) return { items: prior.map(confirmationItem) };
            throw new UserRemovalError(409, '预览已失效，请重新预览。');
        }
        if (entry.pending) return entry.pending;
        const priorByHandle = new Map(prior.map(job => [job.handle, job]));
        entry.pending = Promise.all(entry.rows.map(row => withUserLock(row.handle, async () => {
            const { handle, accountId, rawEmail, email } = row;
            const existing = priorByHandle.get(handle);
            if (existing) return confirmationItem(existing);
            if (!row.eligible) return { handle, ok: false, reason: row.reason };
            const user = await readUser(handle);
            const reason = protection(handle, user, actor);
            if (reason) return { handle, ok: false, reason };
            if (user.accountId !== accountId || emailValue(user) !== rawEmail) return { handle, ok: false, reason: STALE };
            const createdAt = now();
            const job = await persist({
                version: 1, id: randomUUID(), handle, accountId, actorId: actor.accountId, previewId, email,
                state: email ? 'queued' : 'blocked', reason: email ? null : MISSING_EMAIL,
                createdAt, updatedAt: createdAt, acceptedAt: null, purgeAt: null,
                attempts: 0, sendingAt: null, nextAt: email ? createdAt : null,
            });
            return confirmationItem(job);
        }).catch(() => {
            console.error('未能保存延期清除任务。');
            return { handle: row.handle, ok: false, reason: '未能保存任务，请重新预览后重试。' };
        }))).then(async items => {
            const result = { items };
            await writeFileAtomic(path.join(directory, `receipt-${previewId}.json`), JSON.stringify({
                version: 1, previewId, actorId: actor.accountId, items,
            }), { mode: 0o600 });
            receipts.set(previewId, { actorId: actor.accountId, result });
            previews.delete(previewId);
            return result;
        }).finally(() => { entry.pending = null; });
        return entry.pending;
    }

    function deadlineReached(job) {
        return job?.state === 'purging' || (timed(job ?? {}) && job.purgeAt <= now());
    }

    function requireBeforeDeadline(handle, job) {
        if (isUserPurgeBlocked(handle) || deadlineReached(job)) throw new UserRemovalError(409, '账户已到清除截止时间。');
    }

    async function cancel(id, actorId) {
        const found = jobs.get(id);
        if (!found) throw new UserRemovalError(404, '找不到清除任务。');
        return withUserLock(found.handle, async () => {
            const job = jobs.get(id);
            if (job.state === 'cancelled') return publicJob(job);
            if (terminal(job)) throw new UserRemovalError(409, '任务已结束，不能撤销。');
            requireBeforeDeadline(job.handle, job);
            return publicJob(await finish(job, 'cancelled', '管理员已撤销任务。', actorId));
        });
    }

    async function retry(id, actorId) {
        const found = jobs.get(id);
        if (!found) throw new UserRemovalError(404, '找不到清除任务。');
        return withUserLock(found.handle, async () => {
            const job = jobs.get(id);
            if (job.state !== 'blocked' || !job.email) throw new UserRemovalError(409, '只有收件地址有效的待处理任务可以重试。');
            requireBeforeDeadline(job.handle, job);
            const user = await readUser(job.handle);
            if (!identityMatches(job, user) || normalizeNotificationAddress(emailValue(user)) !== job.email) throw new UserRemovalError(409, STALE);
            return publicJob(await update(job, { state: 'queued', reason: null, attempts: 0, nextAt: now(), retriedBy: actorId }));
        });
    }

    async function changeEmail(handle, value, actorId) {
        const email = normalizeNotificationAddress(value);
        if (!isRemovalHandle(handle) || !email) throw new UserRemovalError(400, '用户名或邮箱格式无效。');
        return withUserLock(handle, async () => {
            const job = active.get(handle.toLowerCase());
            requireBeforeDeadline(handle, job);
            const user = await readUser(handle);
            if (!user || user.handle !== handle) throw new UserRemovalError(404, '账户不存在。');
            if (handle.toLowerCase() === DEFAULT_USER.handle || (user.admin && user.accountId !== actorId)) {
                throw new UserRemovalError(403, '不能修改默认账户或其他管理员的邮箱。');
            }
            if (emailValue(user) === email) return { handle, email, removalCancelled: false };
            requireBeforeDeadline(handle, job);
            // 先耐久撤销，邮箱写入失败时宁可保留账户，也不继续按旧地址清除。
            if (job) await finish(job, 'cancelled', '通知邮箱已修改或正在修改，请重新预览。', actorId);
            await writeUser({ ...user, email });
            return { handle, email, removalCancelled: Boolean(job) };
        });
    }

    async function send(candidate, enabled) {
        const { id, handle } = candidate;
        const attempt = await withUserLock(handle, async () => {
            const job = jobs.get(id);
            if (!enabled() || paused() || job.state !== 'queued' || job.sendingAt !== null || job.nextAt > now()) return null;
            const user = await readUser(handle);
            if (!identityMatches(job, user) || normalizeNotificationAddress(emailValue(user)) !== job.email) {
                await update(job, { state: 'blocked', reason: STALE, nextAt: null });
                return null;
            }
            if (!enabled() || paused()) return null;
            return update(job, { sendingAt: now(), attempts: job.attempts + 1 });
        });
        if (!attempt || jobs.get(id) !== attempt) return;
        let acceptedAt;
        let failure;
        try {
            if (!enabled() || paused()) throw Object.assign(new Error(), { deferred: true });
            ({ acceptedAt } = await sendNotice({ email: attempt.email }));
        } catch (error) {
            failure = error ?? {};
        }
        await withUserLock(handle, async () => {
            if (jobs.get(id) !== attempt) return;
            const common = { sendingAt: null, nextAt: null };
            try {
                let patch;
                if (failure?.deferred === true) {
                    patch = { attempts: attempt.attempts - 1, nextAt: now() };
                } else if (!failure && timestamp(acceptedAt) && acceptedAt >= attempt.sendingAt && timestamp(acceptedAt + RETENTION)) {
                    const user = await readUser(handle);
                    patch = identityMatches(attempt, user) && normalizeNotificationAddress(emailValue(user)) === attempt.email
                        ? { state: 'grace', reason: null, acceptedAt, purgeAt: acceptedAt + RETENTION }
                        : { state: 'blocked', reason: STALE };
                } else if (failure?.uncertain === false && failure.retryable === true && attempt.attempts <= BACKOFF.length) {
                    patch = { reason: '通知发送暂时失败，等待重试。', nextAt: now() + BACKOFF[attempt.attempts - 1] };
                } else {
                    patch = { state: 'blocked', reason: failure?.uncertain === false ? '通知未被 SMTP 接受，未开始倒计时。' : UNCERTAIN };
                }
                await update(attempt, { ...common, ...patch });
            } catch {
                // 不重发已提交给 SMTP 的通知。若磁盘不能写，原发送中记录留待启动恢复。
                await update(attempt, { ...common, state: 'blocked', reason: UNCERTAIN });
            }
        });
    }

    async function purge(candidate, enabled) {
        const { id, handle } = candidate;
        const committed = await withUserLock(handle, async () => {
            const job = jobs.get(id);
            if (!deadlineReached(job) || (job.nextAt !== null && job.nextAt > now())) return null;
            const user = await readUser(handle);
            if (!(job.state === 'purging' && user == null) && !identityMatches(job, user)) throw new Error('账户身份或保护状态异常，拒绝清理。');
            if (job.state === 'purging') return job;
            return update(job, { state: 'purging', reason: null, nextAt: null });
        });
        if (!committed) return;
        if (!aborted.has(id)) {
            abortUserOperations(handle);
            aborted.add(id);
        }
        if (!enabled() || paused()) return;
        const idle = await waitForUserOperations(handle, drainTimeoutMs);
        await withUserLock(handle, async () => {
            if (jobs.get(id) !== committed || !enabled() || paused()) return;
            if (!idle) {
                await update(committed, { reason: '仍有在途操作，等待结束后重试。', nextAt: now() + PURGE_RETRY });
                return;
            }
            const user = await readUser(handle);
            if (user != null && !identityMatches(committed, user)) throw new Error('账户身份或保护状态异常，拒绝清理。');
            if (!enabled() || paused()) return;
            try {
                await purgeUser({ id, handle, accountId: committed.accountId });
                await finish(committed, 'cleared', null);
            } catch {
                await update(committed, { reason: '清理未完成，将保持封锁并重试。', nextAt: now() + PURGE_RETRY });
            }
        });
    }

    function dispatch(enabled) {
        prunePreviews();
        const dispatched = [];
        const maintenance = paused();
        let mailSlots = MAX_CONCURRENT_MAIL;
        let purgeSlots = MAX_CONCURRENT_PURGE;
        for (const { clearing } of workers.values()) {
            if (clearing) purgeSlots--;
            else mailSlots--;
        }
        const time = now();
        for (const job of active.values()) {
            const key = job.handle.toLowerCase();
            const due = deadlineReached(job);
            // 到期先中止传输，不让排队中的物理清除或 SMTP 阻塞。
            if (due && !aborted.has(job.id)) {
                setUserPurgeDeadline(job.handle, 0);
                abortUserOperations(job.handle);
                aborted.add(job.id);
            }
            if (workers.has(key)) continue;
            const shouldPurge = !maintenance && purgeSlots > 0 && due && (job.nextAt === null || job.nextAt <= time);
            const shouldSend = !maintenance && mailSlots > 0 && job.state === 'queued' && job.sendingAt === null && job.nextAt <= time;
            if (!shouldPurge && !shouldSend) continue;
            if (shouldPurge) purgeSlots--;
            else mailSlots--;
            const task = (shouldPurge ? purge(job, enabled) : send(job, enabled)).catch(() => {
                console.error('延期清除任务运行失败，未能安全完成。任务编号：', job.id);
            }).finally(() => workers.delete(key));
            workers.set(key, { task, clearing: shouldPurge });
            dispatched.push(task);
        }
        return dispatched;
    }

    return {
        preview, confirm, cancel, retry, changeEmail,
        getRemoval(handle) {
            const job = active.get(handle.toLowerCase());
            return job ? { state: job.state, purgeAt: job.purgeAt } : null;
        },
        list(page = 1) {
            const pageSize = 25;
            const total = jobs.size;
            const totalPages = Math.max(1, Math.ceil(total / pageSize));
            page = Number.isSafeInteger(page) ? Math.max(1, Math.min(page, totalPages)) : 1;
            const offset = (page - 1) * pageSize;
            const items = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)).slice(offset, offset + pageSize).map(publicJob);
            return { items, total, page, pageSize, totalPages };
        },
        runOnce: () => Promise.all(dispatch(() => true)),
        start() {
            if (running) return;
            running = true;
            const tick = () => dispatch(() => running);
            timer = setInterval(tick, 1000);
            timer.unref();
            tick();
        },
        stop() {
            running = false;
            clearInterval(timer);
            return Promise.allSettled([...workers.values()].map(({ task }) => task));
        },
    };
}

let lifecycle;
let initializing = false;

export async function initUserLifecycle(options) {
    if (lifecycle || initializing) throw new Error('延期清除服务已经初始化。');
    initializing = true;
    try {
        lifecycle = await createUserLifecycle(options);
    } finally {
        initializing = false;
    }
}

export function getUserLifecycle() {
    if (!lifecycle) throw new UserRemovalError(503, '延期清除服务尚未就绪。');
    return lifecycle;
}

export function startUserLifecycle() {
    getUserLifecycle().start();
}

export function stopUserLifecycle() {
    return lifecycle?.stop();
}

export function getUserRemoval(handle) {
    return lifecycle?.getRemoval(handle) ?? null;
}

export function hasActiveUserRemoval(handle) {
    return getUserRemoval(handle) !== null;
}
