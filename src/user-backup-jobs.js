/* global AggregateError, BigInt */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { finished, pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import archiver from 'archiver';
import storage from 'node-persist';
import { DEFAULT_USER } from './constants.js';
import { allowKeysExposure, SECRETS_FILE } from './endpoints/secrets.js';
import { acquireUserOperation, getUserPurgeDeadline, isUserPurgeBlocked } from './user-operation-state.js';
import { getUserDirectories, toKey } from './users.js';
import { getConfigValue } from './util.js';

const GiB = 1024 ** 3;
const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const DOWNLOAD_SLOTS = 2;
const MAX_TIMER = 2 ** 31 - 1;
const IO_CHUNK = 64 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const jobs = new Map();
const active = new Set();
let spool;
let options;
let sweepTimer;
let sweeping;
let accepting = false;
let packing = false;

export class BackupError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function setting(key, fallback, min = 1) {
    const value = getConfigValue(`backups.fullData.${key}`, fallback, 'number');
    return Number.isSafeInteger(value) && value >= min ? value : fallback;
}

export function backupPolicyEnabled() {
    return !!getConfigValue('backups.allowFullDataBackup', true, 'boolean');
}

export async function backupAccount(handle) {
    if (!getConfigValue('enableUserAccounts', false, 'boolean')) {
        return handle === DEFAULT_USER.handle ? { ...DEFAULT_USER, accountId: 'default-user' } : null;
    }
    return (await storage.getItem(toKey(handle))) ?? null;
}

export function backupIdentity(profile) {
    if (!getConfigValue('enableUserAccounts', false, 'boolean') && profile?.handle === DEFAULT_USER.handle) {
        return 'default-user';
    }
    return typeof profile?.accountId === 'string' && profile.accountId ? profile.accountId : null;
}

export function assertBackupAvailable() {
    if (!backupPolicyEnabled()) {
        throw new BackupError(403, 'Full data backup is disabled');
    }
    if (!accepting) {
        throw new BackupError(503, 'Backup service unavailable');
    }
}

export function backupDeadline(job) {
    return Math.min(job.expiresAt ?? Infinity,
        getUserPurgeDeadline(job.owner) ?? Infinity,
        getUserPurgeDeadline(job.target) ?? Infinity);
}

function blocked(job) {
    return isUserPurgeBlocked(job.owner) || isUserPurgeBlocked(job.target) || Date.now() >= backupDeadline(job);
}

export function assertBackupLive(job) {
    if (job.removing || blocked(job)) {
        throw new BackupError(410, 'Backup expired or unavailable');
    }
}

export async function verifyBackupAccounts(job) {
    const owner = await backupAccount(job.owner);
    const target = job.owner === job.target ? owner : await backupAccount(job.target);
    if (owner?.enabled !== true || owner.handle !== job.owner || backupIdentity(owner) !== job.ownerId ||
        target?.handle !== job.target || backupIdentity(target) !== job.targetId || (job.owner !== job.target && !owner.admin)) {
        throw new BackupError(403, 'Unauthorized');
    }
}

function startOperation(job, kind, response, rate = 0) {
    assertBackupAvailable();
    assertBackupLive(job);
    if (response?.destroyed) {
        throw new BackupError(410, 'Backup request closed');
    }
    const controller = new AbortController();
    const releases = [];
    const abort = () => {
        controller.abort();
        if (response && !response.writableFinished) {
            response.destroy();
        }
    };
    for (const handle of new Set([job.owner, job.target])) {
        const release = acquireUserOperation(handle, { onAbort: abort });
        if (!release) {
            releases.forEach(release => release());
            throw new BackupError(410, 'Backup expired or unavailable');
        }
        releases.push(release);
    }
    let resolve;
    let timer;
    const operation = { job, kind, rate, abort, done: new Promise(r => { resolve = r; }) };
    const checkDeadline = () => {
        const deadline = backupDeadline(job);
        if (!backupPolicyEnabled() || job.removing || blocked(job)) {
            abort();
        } else if (Number.isFinite(deadline)) {
            timer = setTimeout(checkDeadline, Math.min(MAX_TIMER, Math.max(1, deadline - Date.now())));
            timer.unref();
        }
    };
    active.add(operation);
    response?.once('close', abort);
    checkDeadline();
    return {
        signal: controller.signal,
        finish() {
            clearTimeout(timer);
            response?.off('close', abort);
            active.delete(operation);
            releases.forEach(release => release());
            resolve();
        },
    };
}

function samePath(a, b) {
    return path.relative(a, b) === '';
}

async function checkedStat(file, directory = false) {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1) ||
        !samePath(file, await fs.realpath(file))) {
        throw new BackupError(409, 'Unsafe backup path');
    }
    return stat;
}

function sameFile(a, b) {
    return a.dev === b.dev && a.ino === b.ino;
}

async function openRegular(file) {
    const before = await checkedStat(file);
    const handle = await fs.open(file, constants.O_RDONLY | NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || !sameFile(before, stat) || !sameFile(stat, await checkedStat(file))) {
            throw new BackupError(409, 'Unsafe backup path');
        }
        return { handle, stat };
    } catch (error) {
        await handle.close();
        throw error;
    }
}

function excludesSecrets(name) {
    return name.toLowerCase() === SECRETS_FILE.toLowerCase() || /^backups\/secrets_migration_[^/]*\.json$/i.test(name);
}

async function appendTree(archive, directory, relative, signal, includeSecrets) {
    const before = await checkedStat(directory, true);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    if (!sameFile(before, await checkedStat(directory, true))) {
        throw new BackupError(409, 'Unsafe backup path');
    }
    for (const entry of entries) {
        signal.throwIfAborted();
        // 反斜杠在 ZIP 中可被解压器解释为路径分隔符。
        if (entry.name.includes('\\') || entry.name.includes(':')) {
            throw new BackupError(409, 'Unsafe backup entry');
        }
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (!includeSecrets && excludesSecrets(name)) {
            continue;
        }
        const source = path.join(directory, entry.name);
        if (!sameFile(before, await checkedStat(directory, true))) {
            throw new BackupError(409, 'Unsafe backup path');
        }
        if (entry.isDirectory()) {
            await checkedStat(source, true);
            const done = once(archive, 'entry', { signal });
            archive.append(Buffer.alloc(0), { name: `${name}/`, type: 'directory' });
            await done;
            await appendTree(archive, source, name, signal, includeSecrets);
        } else {
            const { handle, stat } = await openRegular(source);
            try {
                signal.throwIfAborted();
                const input = handle.createReadStream({ autoClose: false, signal });
                const onError = error => archive.destroy(error);
                input.on('error', onError);
                try {
                    const done = once(archive, 'entry', { signal });
                    archive.append(input, { name, mode: stat.mode, date: stat.mtime });
                    await done;
                    const after = await handle.stat();
                    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
                        throw new BackupError(409, '打包过程中源文件已变化，请重新准备备份');
                    }
                } finally {
                    input.destroy();
                    await finished(input, { cleanup: true }).catch(() => {});
                }
            } finally {
                await handle.close();
            }
        }
    }
}

async function writeArchive(job, destination, signal) {
    const dataRoot = path.resolve(globalThis.DATA_ROOT);
    const root = path.resolve(getUserDirectories(job.target).root);
    if (!samePath(path.dirname(root), dataRoot) || samePath(root, spool)) {
        throw new BackupError(409, 'Unsafe backup root');
    }
    await checkedStat(dataRoot, true);
    signal.throwIfAborted();
    const archive = archiver('zip', { forceZip64: true, zlib: { level: 1 } });
    const controller = new AbortController();
    const abort = () => controller.abort();
    const combined = AbortSignal.any([signal, controller.signal]);
    archive.on('warning', error => archive.destroy(error));
    const output = pipeline(archive, destination, { signal: combined }).catch(error => {
        abort();
        throw error;
    });
    // 立即观察输出失败；等待遍历结束后才释放账户操作。
    output.catch(() => {});
    try {
        await appendTree(archive, root, '', combined, job.includesSecrets);
        combined.throwIfAborted();
        await Promise.all([archive.finalize(), output]);
    } catch (error) {
        abort();
        archive.abort();
        await output.catch(() => {});
        throw error;
    }
}

function artifact(id, extension) {
    if (typeof id !== 'string' || !ID.test(id)) {
        throw new BackupError(404, 'Backup not found');
    }
    return path.join(spool, id + extension);
}

async function syncSpool() {
    // Windows 不支持以 Node 文件句柄同步目录；ZIP 和元数据文件自身仍会同步。
    if (process.platform !== 'win32') {
        const directory = await fs.open(spool, constants.O_RDONLY | NOFOLLOW);
        try {
            await directory.sync();
        } finally {
            await directory.close();
        }
    }
}

async function discardArtifacts(id) {
    await checkedStat(spool, true);
    // 先删除发布标记。若删除 ZIP 失败，内存仍保留隔离记录，由清理重试。
    for (const extension of ['.json', '.zip', '.json.part', '.part']) {
        await fs.rm(artifact(id, extension), { force: true });
    }
    await syncSpool();
}

function removeJob(job) {
    job.removing = true;
    if (!job.cleanup) {
        job.cleanup = (async () => {
            const operations = [...active].filter(operation => operation.job === job);
            operations.forEach(operation => operation.abort());
            await Promise.all(operations.map(operation => operation.done));
            await discardArtifacts(job.id);
            jobs.delete(job.id);
        })().finally(() => { job.cleanup = undefined; });
    }
    return job.cleanup;
}

function matchesAccount(job, handle, accountId) {
    return (job.target === handle && (!accountId || job.targetId === accountId)) ||
        (job.owner === handle && (!accountId || job.ownerId === accountId));
}

export async function removeUserBackupJobs(handle, accountId) {
    const operations = [...active].filter(operation => matchesAccount(operation.job, handle, accountId));
    operations.forEach(operation => operation.abort());
    const removals = [...jobs.values()].filter(job => matchesAccount(job, handle, accountId)).map(removeJob);
    const results = await Promise.allSettled([...operations.map(operation => operation.done), ...removals]);
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) {
        throw new AggregateError(failures, '无法隔离账户备份');
    }
}

function storedMetadata(job) {
    const { id, owner, ownerId, target, targetId, expiresAt, size, etag, includesSecrets, stat } = job;
    return { version: 1, id, owner, ownerId, target, targetId, expiresAt, size, etag, includesSecrets, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

function usableMetadata(record, id) {
    return record?.version === 1 && record.id === id &&
        ['owner', 'ownerId', 'target', 'targetId'].every(key => typeof record[key] === 'string' && record[key]) &&
        Number.isSafeInteger(record.expiresAt) && Number.isSafeInteger(record.size) && record.size > 0 &&
        Number.isFinite(record.mtimeMs) && Number.isFinite(record.ctimeMs) &&
        typeof record.etag === 'string' && /^"[a-f0-9]{64}"$/.test(record.etag) && typeof record.includesSecrets === 'boolean';
}

async function loadMetadata(id) {
    try {
        const { handle, stat } = await openRegular(artifact(id, '.json'));
        let record;
        try {
            if (stat.size > 16 * 1024) {
                return null;
            }
            record = JSON.parse(await handle.readFile('utf8'));
        } finally {
            await handle.close();
        }
        if (!usableMetadata(record, id) || blocked(record) || (!allowKeysExposure && record.includesSecrets)) {
            return null;
        }
        const statZip = await checkedStat(artifact(id, '.zip'));
        return statZip.size === record.size && statZip.mtimeMs === record.mtimeMs && statZip.ctimeMs === record.ctimeMs
            ? { ...record, state: 'ready', stat: statZip } : null;
    } catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError || error instanceof BackupError) {
            return null;
        }
        throw error;
    }
}

export async function initUserBackupJobs() {
    if (accepting) {
        return;
    }
    options = {
        maxArchive: setting('maxArchiveBytes', 10 * GiB),
        maxUser: setting('maxUserBytes', 12 * GiB),
        maxTotal: setting('maxTotalBytes', 40 * GiB),
        minFree: setting('minFreeBytes', 2 * GiB, 0),
        maxQueued: setting('maxQueuedJobs', 20),
        ttl: Math.min(setting('ttlHours', 72), Math.floor(Number.MAX_SAFE_INTEGER / 3600000 / 2)) * 3600000,
        rate: setting('bytesPerSecond', 1024 ** 2, DOWNLOAD_SLOTS),
    };
    const root = path.resolve(globalThis.DATA_ROOT);
    await checkedStat(root, true);
    spool = path.join(root, '_backup-downloads');
    await fs.mkdir(spool, { mode: 0o700 }).catch(error => {
        if (error.code !== 'EEXIST') {
            throw error;
        }
    });
    await checkedStat(spool, true);
    if (process.platform !== 'win32') {
        await fs.chmod(spool, 0o700);
    }
    const entries = await fs.readdir(spool);
    const ids = new Set(entries.map(name => name.split('.')[0]).filter(id => ID.test(id)));
    jobs.clear();
    for (const id of ids) {
        const job = await loadMetadata(id);
        if (!job) {
            await discardArtifacts(id);
            continue;
        }
        if (job.size > quotaBudget(job)) {
            await discardArtifacts(id);
            continue;
        }
        await fs.rm(artifact(id, '.part'), { force: true });
        await fs.rm(artifact(id, '.json.part'), { force: true });
        jobs.set(id, job);
    }
    accepting = true;
    sweepTimer = setInterval(runSweep, 1000);
    sweepTimer.unref();
}

export async function stopUserBackupJobs() {
    accepting = false;
    clearInterval(sweepTimer);
    const operations = [...active];
    operations.forEach(operation => operation.abort());
    await Promise.all(operations.map(operation => operation.done));
    await sweeping;
    await Promise.all([...jobs.values()].map(job => job.cleanup));
    jobs.clear();
}

function runSweep() {
    if (sweeping || !accepting) {
        return;
    }
    sweeping = (async () => {
        for (const operation of active) {
            if (!backupPolicyEnabled() || blocked(operation.job)) {
                operation.abort();
            }
        }
        const obsolete = [...jobs.values()].filter(job => job.removing || blocked(job));
        const results = await Promise.allSettled(obsolete.map(removeJob));
        if (results.some(result => result.status === 'rejected')) {
            console.error('部分用户备份文件未能清理，将重试。');
        }
    })().finally(() => { sweeping = undefined; });
    sweeping.catch(() => console.error('用户备份清理失败，将重试。'));
}

function quotaBudget(job) {
    let total = options.maxTotal;
    let owner = options.maxUser;
    let target = options.maxUser;
    for (const existing of jobs.values()) {
        if (existing !== job && existing.size) {
            total -= existing.size;
            if (matchesAccount(existing, job.owner, job.ownerId)) owner -= existing.size;
            if (matchesAccount(existing, job.target, job.targetId)) target -= existing.size;
        }
    }
    return Math.min(total, owner, target, options.maxArchive);
}

async function writeSpool(job, signal) {
    await checkedStat(spool, true);
    const limit = quotaBudget(job);
    if (limit <= 0) {
        throw new BackupError(507, 'Backup storage limit reached');
    }
    const hash = createHash('sha256');
    let size = 0;
    let available = 0;
    const partial = await fs.open(artifact(job.id, '.part'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    try {
        await writeArchive(job, async function (source) {
            for await (const chunk of source) {
                signal.throwIfAborted();
                if (size + chunk.length > limit) {
                    throw new BackupError(507, 'Backup storage limit reached');
                }
                if (available < chunk.length) {
                    const space = await fs.statfs(spool, { bigint: true });
                    const usable = space.bavail * space.bsize - BigInt(options.minFree);
                    available = Number(usable > BigInt(4 * 1024 ** 2) ? BigInt(4 * 1024 ** 2) : usable);
                    if (available < chunk.length) {
                        throw new BackupError(507, 'Insufficient backup disk space');
                    }
                }
                await partial.writeFile(chunk);
                hash.update(chunk);
                size += chunk.length;
                available -= chunk.length;
            }
        }, signal);
        await partial.sync();
    } finally {
        await partial.close();
    }
    signal.throwIfAborted();
    assertBackupLive(job);
    await verifyBackupAccounts(job);
    signal.throwIfAborted();
    job.size = size;
    job.etag = `"${hash.digest('hex')}"`;
    await checkedStat(spool, true);
    await fs.rename(artifact(job.id, '.part'), artifact(job.id, '.zip'));
    job.stat = await checkedStat(artifact(job.id, '.zip'));
    job.expiresAt = Date.now() + options.ttl;
    await syncSpool();
    const meta = await fs.open(artifact(job.id, '.json.part'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    try {
        await meta.writeFile(JSON.stringify(storedMetadata(job)));
        await meta.sync();
    } finally {
        await meta.close();
    }
    signal.throwIfAborted();
    assertBackupLive(job);
    await fs.rename(artifact(job.id, '.json.part'), artifact(job.id, '.json'));
    await syncSpool();
    job.stat = await checkedStat(artifact(job.id, '.zip'));
    signal.throwIfAborted();
    assertBackupLive(job);
    job.state = 'ready';
}

async function runPacking() {
    if (packing || !accepting) {
        return;
    }
    const job = [...jobs.values()].find(job => job.state === 'queued' && !job.removing);
    if (!job) {
        return;
    }
    packing = true;
    let operation;
    try {
        operation = startOperation(job, 'pack');
        job.state = 'running';
        await verifyBackupAccounts(job);
        await writeSpool(job, operation.signal);
    } catch (error) {
        job.error = error instanceof BackupError ? error.message : 'Backup could not be created';
        job.expiresAt = Math.min(job.expiresAt, Date.now() + 5 * 60 * 1000);
        if (!job.removing) {
            try {
                await discardArtifacts(job.id);
                delete job.size;
                delete job.etag;
            } catch {
                job.removing = true;
                console.error('用户备份失败，部分文件尚未清理。');
            }
        }
        job.state = 'failed';
    } finally {
        operation?.finish();
        packing = false;
        if (accepting) {
            queueMicrotask(runPacking);
        }
    }
}

export function enqueueBackup(subject) {
    assertBackupAvailable();
    assertBackupLive(subject);
    const queued = [...jobs.values()].filter(job => job.state === 'queued' && !job.removing);
    if (queued.length >= options.maxQueued) {
        throw new BackupError(429, 'Backup queue is full');
    }
    const job = { ...subject, id: randomUUID(), state: 'queued', includesSecrets: allowKeysExposure, expiresAt: Date.now() + options.ttl };
    if (quotaBudget(job) <= 0) {
        throw new BackupError(507, 'Backup storage limit reached');
    }
    jobs.set(job.id, job);
    queueMicrotask(runPacking);
    return backupStatus(job);
}

export function backupStatus(job) {
    const { id, state, size, error } = job;
    return { id, state, expiresAt: backupDeadline(job), size: state === 'ready' ? size : undefined, error };
}

export function lookupBackup(id, profile) {
    assertBackupAvailable();
    const job = typeof id === 'string' && ID.test(id) ? jobs.get(id) : null;
    if (!job || job.owner !== profile?.handle || job.ownerId !== backupIdentity(profile)) {
        throw new BackupError(404, 'Backup not found');
    }
    if (job.owner !== job.target && !profile.admin) {
        throw new BackupError(403, 'Unauthorized');
    }
    if (job.includesSecrets && !allowKeysExposure) {
        throw new BackupError(403, 'Unauthorized');
    }
    assertBackupLive(job);
    return job;
}

function admitDownload(job, length) {
    const downloads = [...active].filter(operation => operation.kind === 'download');
    if (downloads.length >= DOWNLOAD_SLOTS || downloads.some(operation =>
        matchesAccount(operation.job, job.owner, job.ownerId) || matchesAccount(operation.job, job.target, job.targetId))) {
        throw new BackupError(429, 'Backup download limit reached');
    }
    const remaining = options.rate - downloads.reduce((used, operation) => used + operation.rate, 0);
    const duration = backupDeadline(job) - Date.now();
    // 优先保留第二个槽位的带宽；时间不足时可占用当前所有余量，不降低已开始的下载速率。
    const preferred = Math.min(remaining, Math.floor(options.rate / DOWNLOAD_SLOTS));
    for (const rate of new Set([preferred, remaining])) {
        if (rate <= 0) continue;
        const chunks = Math.floor(length / IO_CHUNK);
        const tail = length % IO_CHUNK;
        const estimate = chunks * Math.ceil(IO_CHUNK / rate * 1000) + Math.ceil(tail / rate * 1000);
        if (estimate < duration) return rate;
    }
    if (remaining <= 0) throw new BackupError(429, 'Backup download bandwidth is busy');
    throw new BackupError(503, 'Backup transfer cannot finish before expiry; request a smaller range');
}

async function* pace(source, rate, limit, signal, exact = false) {
    let bytes = 0;
    for await (const chunk of source) {
        if (bytes + chunk.length > limit) {
            throw new BackupError(507, 'Backup archive limit reached');
        }
        bytes += chunk.length;
        for (let offset = 0; offset < chunk.length; offset += IO_CHUNK) {
            const slice = chunk.subarray(offset, offset + IO_CHUNK);
            await sleep(Math.ceil(slice.length / rate * 1000), undefined, { signal });
            yield slice;
        }
    }
    if (exact && bytes !== limit) {
        throw new BackupError(409, 'Backup archive changed');
    }
}

export async function withBackupFile(job, response, range, sendHeaders, head) {
    assertBackupAvailable();
    if (job.state !== 'ready') {
        throw new BackupError(409, 'Backup is not ready');
    }
    const length = range.end - range.start + 1;
    if (head && [...active].filter(operation => operation.kind === 'metadata').length >= DOWNLOAD_SLOTS) {
        throw new BackupError(429, 'Backup metadata limit reached');
    }
    const rate = head ? 0 : admitDownload(job, length);
    const operation = startOperation(job, head ? 'metadata' : 'download', response, rate);
    try {
        await checkedStat(spool, true);
        const { handle, stat } = await openRegular(artifact(job.id, '.zip'));
        try {
            operation.signal.throwIfAborted();
            if (!sameFile(stat, job.stat) || stat.size !== job.size || stat.mtimeMs !== job.stat.mtimeMs || stat.ctimeMs !== job.stat.ctimeMs) {
                throw new BackupError(409, 'Backup archive changed');
            }
            assertBackupLive(job);
            sendHeaders();
            if (head) {
                response.end();
                return;
            }
            const input = handle.createReadStream({ start: range.start, end: range.end, autoClose: false, highWaterMark: IO_CHUNK });
            try {
                await pipeline(input, (source, { signal }) => pace(source, rate, length, signal, true), response, { signal: operation.signal });
            } finally {
                input.destroy();
                await finished(input, { cleanup: true }).catch(() => {});
            }
        } finally {
            await handle.close();
        }
    } finally {
        operation.finish();
    }
}

export async function streamLegacyBackup(subject, response) {
    assertBackupAvailable();
    if (packing || [...jobs.values()].some(job => job.state === 'queued' && !job.removing)) {
        throw new BackupError(429, 'Backup packer is busy');
    }
    const job = { ...subject, includesSecrets: allowKeysExposure };
    const rate = admitDownload(job, 0);
    const operation = startOperation(job, 'download', response, rate);
    packing = true;
    try {
        await writeArchive(job, async function (source, { signal }) {
            await pipeline(pace(source, rate, options.maxArchive, signal), response, { signal });
        }, operation.signal);
    } finally {
        operation.finish();
        packing = false;
        if (accepting) {
            queueMicrotask(runPacking);
        }
    }
}
