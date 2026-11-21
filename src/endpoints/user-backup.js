/* global BigInt */
import express from 'express';
import {
    BackupError, assertBackupAvailable, assertBackupLive, backupAccount,
    backupIdentity, backupStatus, enqueueBackup, lookupBackup, streamLegacyBackup,
    verifyBackupAccounts, withBackupFile,
} from '../user-backup-jobs.js';
import { generateTimestamp } from '../util.js';

export const router = express.Router();
export default router;

function endpoint(handler) {
    return async (request, response) => {
        response.set('Cache-Control', 'private, no-store, no-transform');
        try {
            assertBackupAvailable();
            await handler(request, response);
        } catch (error) {
            if (response.destroyed) return;
            if (response.headersSent) {
                response.destroy();
                return;
            }
            for (const header of ['Content-Disposition', 'Content-Length', 'Content-Range', 'Content-Encoding', 'ETag']) {
                response.removeHeader(header);
            }
            if (error instanceof BackupError) {
                response.status(error.status).json({ error: error.message });
            } else {
                console.error('用户备份请求失败。', error.code ?? error.name);
                response.status(500).json({ error: 'Backup request failed' });
            }
        }
    };
}

async function subjectFor(request) {
    const handle = request.body?.handle;
    if (typeof handle !== 'string' || !handle) {
        throw new BackupError(400, 'Missing required fields');
    }
    const profile = request.user?.profile;
    const ownerId = backupIdentity(profile);
    if (!ownerId || (handle !== profile.handle && !profile.admin)) {
        throw new BackupError(403, 'Unauthorized');
    }
    const target = await backupAccount(handle);
    if (!target || target.handle !== handle) {
        throw new BackupError(404, 'User not found');
    }
    const targetId = backupIdentity(target);
    if (!targetId || (handle === profile.handle && targetId !== ownerId)) {
        throw new BackupError(403, 'Unauthorized');
    }
    const subject = { owner: profile.handle, ownerId, target: handle, targetId };
    await verifyBackupAccounts(subject);
    assertBackupLive(subject);
    return subject;
}

function attachment(response, handle, suffix = generateTimestamp()) {
    response.attachment(`${handle}-${suffix}.zip`);
    response.set('Content-Encoding', 'identity');
    response.set('X-Content-Type-Options', 'nosniff');
}

router.post('/backup', endpoint(async (request, response) => {
    const subject = await subjectFor(request);
    attachment(response, subject.target);
    await streamLegacyBackup(subject, response);
}));

router.post('/backup/jobs', endpoint(async (request, response) => {
    const subject = await subjectFor(request);
    response.status(202).json(enqueueBackup(subject));
}));

async function authorizedJob(request) {
    const job = lookupBackup(request.params.id, request.user?.profile);
    await verifyBackupAccounts(job);
    assertBackupLive(job);
    return job;
}

router.get('/backup/jobs/:id', endpoint(async (request, response) => {
    response.json(backupStatus(await authorizedJob(request)));
}));

function byteRange(header, size) {
    if (!header || !/^bytes=/i.test(header)) return undefined;
    // 只支持单区间；超长数字不会被舍入到另一个有效区间。
    const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
    if (!match || (!match[1] && !match[2])) return null;
    const limit = BigInt(size);
    const end = match[2] ? BigInt(match[2]) : limit - 1n;
    if (!match[1]) {
        if (end === 0n) return null;
        return { start: end >= limit ? 0 : Number(limit - end), end: size - 1 };
    }
    const start = BigInt(match[1]);
    if (start >= limit || end < start) return null;
    return { start: Number(start), end: end >= limit ? size - 1 : Number(end) };
}

const file = endpoint(async (request, response) => {
    const job = await authorizedJob(request);
    if (job.state !== 'ready') throw new BackupError(409, 'Backup is not ready');
    const head = request.method === 'HEAD';
    const ifRange = request.get('If-Range');
    const partial = !head && (!ifRange || ifRange === job.etag) ? byteRange(request.get('Range'), job.size) : undefined;
    const range = partial ?? { start: 0, end: job.size - 1 };
    await withBackupFile(job, response, range, () => {
        response.set('Accept-Ranges', 'bytes');
        response.set('ETag', job.etag);
        if (partial === null) {
            response.status(416).set('Content-Range', `bytes */${job.size}`);
            return;
        }
        attachment(response, job.target, job.id.slice(0, 8));
        response.set('Content-Length', String(range.end - range.start + 1));
        if (partial) {
            response.status(206).set('Content-Range', `bytes ${range.start}-${range.end}/${job.size}`);
        }
    }, head || partial === null);
});

router.head('/backup/jobs/:id/file', file);
router.get('/backup/jobs/:id/file', file);
