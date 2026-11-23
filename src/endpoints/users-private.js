import path from 'node:path';
import { promises as fsPromises } from 'node:fs';
import crypto from 'node:crypto';

import storage from 'node-persist';
import express from 'express';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';

import { getUserAvatar, toKey, getPasswordHash, getPasswordSalt, ensureUserDirectories, toAvatarKey, getAccountVersion, saveUserRecord } from '../users.js';
import { getUserRemoval } from '../user-lifecycle.js';
import { isUserPurgeBlocked, withUserLock } from '../user-operation-state.js';
import { SETTINGS_FILE } from '../constants.js';
import { checkForNewContent, CONTENT_TYPES } from './content-manager.js';
import { color, Cache, getConfigValue } from '../util.js';
import { getIpAddress, retryAfter } from '../express-common.js';

const RESET_POINTS = getConfigValue('rateLimiting.accountsResetMaxAttempts', 5, 'number');
const PREFER_REAL_IP_HEADER = getConfigValue('rateLimiting.preferRealIpHeader', false, 'boolean');
const RESET_CACHE = new Cache(5 * 60 * 1000);
const generateResetCode = () => Array.from({ length: 6 }, () => crypto.randomInt(0, 10)).join('');
const resetLimiter = new RateLimiterMemory({
    points: RESET_POINTS > 0 ? RESET_POINTS : Number.MAX_SAFE_INTEGER,
    duration: 300,
});

export const router = express.Router();

router.post('/logout', (request, response) => {
    request.session = null;
    return response.sendStatus(204);
});

router.get('/me', async (request, response) => {
    try {
        const user = request.user.profile;
        const avatar = await getUserAvatar(user.handle);
        // 头像改为可缓存的独立地址，避免每次初始化都把 base64 塞进账户信息。
        const avatarUrl = typeof avatar === 'string' && avatar.startsWith('data:')
            ? `/api/users/me/avatar?v=${crypto.createHash('sha256').update(avatar).digest('hex').slice(0, 16)}`
            : avatar;
        return response.set('Cache-Control', 'private, no-store').json({
            handle: user.handle,
            name: user.name,
            avatar: avatarUrl,
            admin: user.admin,
            password: Boolean(user.password),
            created: user.created,
            removal: getUserRemoval(user.handle),
        });
    } catch (error) {
        console.error('读取账号信息失败:', error);
        return response.sendStatus(500);
    }
});

router.get('/me/avatar', async (request, response) => {
    try {
        const avatar = await getUserAvatar(request.user.profile.handle);
        const match = typeof avatar === 'string'
            ? /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s.exec(avatar)
            : null;

        if (!match) {
            return response.sendStatus(404);
        }

        const buffer = Buffer.from(match[2], 'base64');
        response.set('Content-Type', match[1]);
        response.set('Content-Length', String(buffer.length));
        // 地址带有头像内容哈希，可长期缓存且不会出现换头像后仍显示旧图。
        response.set('Cache-Control', 'private, max-age=86400, immutable');
        response.set('X-Content-Type-Options', 'nosniff');
        return response.send(buffer);
    } catch (error) {
        console.error('读取账号头像失败:', error);
        return response.sendStatus(500);
    }
});

function editAccount(action) {
    return async (request, response) => {
        const handle = request.body?.handle;
        if (typeof handle !== 'string' || !handle) return response.status(400).json({ error: '用户名无效' });
        if (handle !== request.user.profile.handle && !request.user.profile.admin) return response.sendStatus(403);
        try {
            return await withUserLock(handle, async () => {
                const user = await storage.getItem(toKey(handle));
                if (!user) return response.status(404).json({ error: '账号不存在' });
                if (isUserPurgeBlocked(handle)) return response.status(409).json({ error: '账号已到清除截止时间' });
                return await action(user, request, response);
            });
        } catch (error) {
            console.error('更新账号设置失败:', error);
            return response.sendStatus(500);
        }
    };
}

router.post('/change-avatar', editAccount(async (user, request, response) => {
    const { avatar } = request.body;
    if (typeof avatar !== 'string' || (avatar && !avatar.startsWith('data:image/'))) {
        return response.status(400).json({ error: '头像格式无效' });
    }
    await storage.setItem(toAvatarKey(user.handle), avatar);
    return response.sendStatus(204);
}));

router.post('/change-password', editAccount(async (user, request, response) => {
    const { oldPassword, newPassword } = request.body;
    if (!user.enabled) return response.status(403).json({ error: '账号已禁用' });
    if (newPassword !== undefined && typeof newPassword !== 'string') return response.status(400).json({ error: '密码格式无效' });
    if (!request.user.profile.admin && user.password && (typeof oldPassword !== 'string' || user.password !== getPasswordHash(oldPassword, user.salt))) {
        return response.status(403).json({ error: '当前密码不正确' });
    }
    const previousVersion = getAccountVersion(user);
    user.salt = newPassword ? getPasswordSalt() : '';
    user.password = newPassword ? getPasswordHash(newPassword, user.salt) : '';
    await saveUserRecord(user);
    if (request.session?.handle === user.handle && request.session.version === previousVersion) {
        request.session.version = getAccountVersion(user);
    }
    return response.sendStatus(204);
}));

router.post('/change-name', editAccount(async (user, request, response) => {
    const { name } = request.body;
    if (typeof name !== 'string' || !name.trim()) return response.status(400).json({ error: '显示名无效' });
    user.name = name.trim();
    await saveUserRecord(user);
    return response.sendStatus(204);
}));

router.post('/reset-settings', async (request, response) => {
    try {
        const password = request.body?.password;
        const user = request.user.profile;
        if (user.password && (typeof password !== 'string' || user.password !== getPasswordHash(password, user.salt))) {
            return response.status(403).json({ error: '当前密码不正确' });
        }
        await fsPromises.rm(path.join(request.user.directories.root, SETTINGS_FILE), { force: true });
        await checkForNewContent([request.user.directories], [CONTENT_TYPES.SETTINGS]);
        return response.sendStatus(204);
    } catch (error) {
        console.error('重置用户设置失败:', error);
        return response.sendStatus(500);
    }
});

router.post('/reset-step1', async (request, response) => {
    try {
        const ip = getIpAddress(request, PREFER_REAL_IP_HEADER);
        const rateLimit = await resetLimiter.get(ip);
        if (rateLimit !== null && rateLimit.consumedPoints > resetLimiter.points) throw rateLimit;
        const user = request.user.profile;
        const resetCode = generateResetCode();
        console.log(color.magenta(`${user.name}，账号数据重置验证码：`) + color.red(resetCode));
        RESET_CACHE.set(user.accountId ?? user.handle, resetCode);
        return response.sendStatus(204);
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            return retryAfter(response, error).status(429).json({ error: '尝试次数过多，请稍后再试或联系管理员' });
        }
        console.error('生成重置验证码失败:', error);
        return response.sendStatus(500);
    }
});

router.post('/reset-step2', async (request, response) => {
    const { code, password } = request.body ?? {};
    const user = request.user.profile;
    if (typeof code !== 'string' || !code) return response.status(400).json({ error: '缺少重置验证码' });
    if (user.password && (typeof password !== 'string' || user.password !== getPasswordHash(password, user.salt))) {
        return response.status(400).json({ error: '当前密码不正确' });
    }
    try {
        const ip = getIpAddress(request, PREFER_REAL_IP_HEADER);
        return await withUserLock(user.handle, async () => {
            if (isUserPurgeBlocked(user.handle)) return response.sendStatus(403);
            const rateLimit = await resetLimiter.get(ip);
            if (rateLimit !== null && rateLimit.consumedPoints > resetLimiter.points) throw rateLimit;
            const identity = user.accountId ?? user.handle;
            if (code !== RESET_CACHE.get(identity)) {
                await resetLimiter.consume(ip);
                return response.status(400).json({ error: '验证码错误' });
            }
            RESET_CACHE.remove(identity);
            await fsPromises.rm(request.user.directories.root, { recursive: true, force: true });
            ensureUserDirectories(user.handle);
            await checkForNewContent([request.user.directories]);
            await resetLimiter.delete(ip);
            return response.sendStatus(204);
        });
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            return retryAfter(response, error).status(429).json({ error: '尝试次数过多，请稍后再试或联系管理员' });
        }
        console.error('重置账号数据失败:', error);
        return response.sendStatus(500);
    }
});
