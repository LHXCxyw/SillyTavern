import path from 'node:path';
import fs from 'node:fs/promises';
import storage from 'node-persist';
import { DEFAULT_USER, UPLOADS_DIRECTORY } from './constants.js';
import { forgetUserDirectories, getUserDirectories, toAvatarKey, toKey } from './users.js';
import { clearUserCharacterCache } from './endpoints/characters.js';
import { clearChatBackupTimers } from './endpoints/chats.js';
import { clearDataMaidTokens } from './endpoints/data-maid.js';
import { clearSettingsBackupTimer } from './endpoints/settings.js';
import { clearUserStats } from './endpoints/stats.js';
import { isUserPurgeBlocked } from './user-operation-state.js';
import { removeAccount } from './account-store.js';
import { removeUserBackupJobs } from './user-backup-jobs.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/**
 * 只接受父目录下的真实目录，不跟随符号链接或 Windows 目录联接。
 * @param {string} target 待检查目录
 * @returns {Promise<import('node:fs').Stats | null>}
 */
async function checkDirectory(target) {
    let detail;
    try {
        detail = await fs.lstat(target);
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
    if (!detail.isDirectory() || path.relative(target, await fs.realpath(target))) {
        throw new Error('清除目标不是预期的真实目录。');
    }
    return detail;
}

async function checkTree(directory, device) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        const stat = await fs.lstat(filename);
        if (stat.dev !== device || !(stat.isDirectory() || (stat.isFile() && stat.nlink === 1))) {
            throw new Error('清除范围内含链接、挂载点或非普通文件，请人工检查。');
        }
        if (stat.isDirectory()) await checkTree(filename, device);
    }
}

/**
 * 在清除任务持有账户锁、在途操作已排空后执行。账号键最后移除，以便中断后重试。
 * @param {{id:string,handle:string,accountId:string}} job 已持久确认的清除任务
 */
export async function purgeUserData({ id, handle, accountId }) {
    if (!UUID.test(id) || !UUID.test(accountId) || !/^[a-z0-9][a-z0-9-]{0,254}$/i.test(handle)
        || handle.toLowerCase() === DEFAULT_USER.handle || !isUserPurgeBlocked(handle)) {
        throw new Error('清除任务身份校验失败。');
    }
    const user = await storage.getItem(toKey(handle));
    if (user && (user.handle !== handle || user.accountId !== accountId || user.admin)) {
        throw new Error('清除对象已变化或受保护。');
    }

    const dataRoot = await fs.realpath(globalThis.DATA_ROOT);
    const source = path.join(dataRoot, handle);
    const holding = path.join(dataRoot, '_user-purge');
    const staged = path.join(holding, id);
    await fs.mkdir(holding, { mode: 0o700, recursive: true });
    const rootDevice = (await fs.stat(dataRoot)).dev;
    const stagingRoot = await checkDirectory(holding);
    const sourceEntry = await checkDirectory(source);
    const stagedEntry = await checkDirectory(staged);
    if (stagingRoot?.dev !== rootDevice || (sourceEntry && (stagedEntry || !user))) {
        throw new Error('清除目录未在预期的数据卷，或发现非预期的同名目录。');
    }
    for (const [directory, entry] of [[source, sourceEntry], [staged, stagedEntry]]) {
        if (!entry) continue;
        if (entry.dev !== rootDevice) throw new Error('不清除单独挂载的用户目录。');
        await checkTree(directory, rootDevice);
    }
    const uploadRoot = path.join(dataRoot, UPLOADS_DIRECTORY);
    const uploads = path.join(uploadRoot, accountId);
    const uploadEntry = await checkDirectory(uploadRoot) ? await checkDirectory(uploads) : null;
    if (uploadEntry) await checkTree(uploads, uploadEntry.dev);

    clearChatBackupTimers(handle);
    clearSettingsBackupTimer(handle);
    clearUserStats(handle);
    clearDataMaidTokens(handle);
    await clearUserCharacterCache(handle, getUserDirectories(handle));
    await removeUserBackupJobs(handle, accountId);

    if (uploadEntry) await fs.rm(uploads, { recursive: true, force: true });
    if (sourceEntry) await fs.rename(source, staged);
    if (sourceEntry || stagedEntry) await fs.rm(staged, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    await storage.removeItem(toAvatarKey(handle));
    await storage.removeItem(toKey(handle));
    removeAccount(handle);
    forgetUserDirectories(handle);
}
