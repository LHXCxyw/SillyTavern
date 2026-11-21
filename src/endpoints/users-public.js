import crypto from 'node:crypto';

import storage from 'node-persist';
import express from 'express';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { getIpAddress, retryAfter } from '../express-common.js';
import { color, Cache, getConfigValue } from '../util.js';
import { KEY_PREFIX, getUserAvatar, toKey, getPasswordHash, getPasswordSalt, getAccountVersion, canCreateUserAccount, ensureUserDirectories, establishUserSession } from '../users.js';
import { acquireUserOperation, isUserPurgeBlocked, withUserLock } from '../user-operation-state.js';
import { checkForNewContent, CONTENT_TYPES } from './content-manager.js';
import { generateEmailCode, isQQEmail, removeEmailCode, saveEmailCode, sendPasswordResetEmail, sendVerificationEmail, verifyEmailCode } from '../emailVerification.js';
import { markCardKeyAsUsed, verifyCardKey } from '../cardkeys.js';

const DISCREET_LOGIN = getConfigValue('enableDiscreetLogin', false, 'boolean');
const PREFER_REAL_IP_HEADER = getConfigValue('rateLimiting.preferRealIpHeader', false, 'boolean');
const LOGIN_POINTS = getConfigValue('rateLimiting.accountsLoginMaxAttempts', 5, 'number');
const RECOVER_POINTS = getConfigValue('rateLimiting.accountsRecoverMaxAttempts', 5, 'number');
const REGISTER_POINTS = getConfigValue('rateLimiting.accountsRegisterMaxAttempts', 5, 'number');
const VERIFICATION_POINTS = getConfigValue('rateLimiting.accountsVerificationMaxAttempts', 3, 'number');
const MFA_CACHE = new Cache(5 * 60 * 1000);

const generateRecoveryCode = () => Array.from({ length: 6 }, () => crypto.randomInt(0, 10)).join('');

export const router = express.Router();
const loginLimiter = new RateLimiterMemory({
    points: LOGIN_POINTS > 0 ? LOGIN_POINTS : Number.MAX_SAFE_INTEGER,
    duration: 60,
});
const recoverLimiter = new RateLimiterMemory({
    points: RECOVER_POINTS > 0 ? RECOVER_POINTS : Number.MAX_SAFE_INTEGER,
    duration: 300,
});
const registerLimiter = new RateLimiterMemory({
    points: REGISTER_POINTS > 0 ? REGISTER_POINTS : Number.MAX_SAFE_INTEGER,
    duration: 300,
});
const verificationLimiter = new RateLimiterMemory({
    points: VERIFICATION_POINTS > 0 ? VERIFICATION_POINTS : Number.MAX_SAFE_INTEGER,
    duration: 300,
});

router.post('/list', async (_request, response) => {
    try {
        if (DISCREET_LOGIN) {
            return response.sendStatus(204);
        }

        /** @type {import('../users.js').User[]} */
        const users = await storage.values(x => x.key.startsWith(KEY_PREFIX));

        /** @type {Promise<import('../users.js').UserViewModel>[]} */
        const viewModelPromises = users
            .filter(x => x.enabled && !isUserPurgeBlocked(x.handle))
            .map(user => new Promise(async (resolve) => {
                getUserAvatar(user.handle).then(avatar =>
                    resolve({
                        handle: user.handle,
                        name: user.name,
                        created: user.created,
                        avatar: avatar,
                        password: !!user.password,
                    }),
                );
            }));

        const viewModels = await Promise.all(viewModelPromises);
        viewModels.sort((x, y) => (x.created ?? 0) - (y.created ?? 0));
        return response.json(viewModels);
    } catch (error) {
        console.error('User list failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/login', async (request, response) => {
    try {
        if (typeof request.body?.handle !== 'string' || !request.body.handle) {
            console.warn('Login failed: Missing required fields');
            return response.status(400).json({ error: '缺少必要参数' });
        }

        const ip = getIpAddress(request, PREFER_REAL_IP_HEADER);
        await loginLimiter.consume(ip);

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));

        if (!user) {
            console.error('Login failed: User', request.body.handle, 'not found');
            return response.status(403).json({ error: '账号或密码错误' });
        }

        if (!user.enabled || isUserPurgeBlocked(user.handle)) {
            console.warn('Login failed: User', user.handle, 'is disabled');
            return response.status(403).json({ error: '该账号已被禁用' });
        }

        if (user.password && (typeof request.body.password !== 'string' || user.password !== getPasswordHash(request.body.password, user.salt))) {
            console.warn('Login failed: Incorrect password for', user.handle);
            return response.status(403).json({ error: '账号或密码错误' });
        }

        if (!request.session) {
            console.error('Session not available');
            return response.sendStatus(500);
        }

        if (!await establishUserSession(request, user, { explicit: true })) {
            return response.status(403).json({ error: '账号或密码已变更，请重新登录' });
        }
        await loginLimiter.delete(ip);
        console.info('Login successful:', user.handle, 'from', ip, 'at', new Date().toLocaleString());
        return response.json({ handle: user.handle });
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            console.error('Login failed: Rate limited from', getIpAddress(request, PREFER_REAL_IP_HEADER));
            return retryAfter(response, error).status(429).send({ error: '尝试次数过多，请稍后再试或找回密码' });
        }

        console.error('Login failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/recover-step1', async (request, response) => {
    try {
        if (typeof request.body?.handle !== 'string' || !request.body.handle) {
            console.warn('Recover step 1 failed: Missing required fields');
            return response.status(400).json({ error: '缺少必要参数' });
        }

        const ip = getIpAddress(request, PREFER_REAL_IP_HEADER);
        await recoverLimiter.consume(ip);

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));

        if (!user) {
            console.error('Recover step 1 failed: User', request.body.handle, 'not found');
            return response.status(404).json({ error: '用户不存在' });
        }

        const release = user.enabled && acquireUserOperation(user.handle);
        if (!release) return response.status(403).json({ error: '该账号当前不可找回' });
        try {
            const mfaCode = generateRecoveryCode();
            if (user.email && isQQEmail(user.email)) {
                await sendPasswordResetEmail(user.email, mfaCode);
            } else {
                console.log();
                console.log(color.blue(`${user.name}, your password recovery code is: `) + color.magenta(mfaCode));
                console.log();
            }
            if (isUserPurgeBlocked(user.handle)) return response.sendStatus(403);
            MFA_CACHE.set(user.accountId, { code: mfaCode, email: user.email ?? '', version: getAccountVersion(user) });
            return response.sendStatus(204);
        } finally {
            release();
        }
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            console.error('Recover step 1 failed: Rate limited from', getIpAddress(request, PREFER_REAL_IP_HEADER));
            return retryAfter(response, error).status(429).send({ error: '尝试次数过多，请稍后再试或联系管理员' });
        }

        console.error('Recover step 1 failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/send-verification', async (request, response) => {
    try {
        const email = String(request.body.email ?? '').trim().toLowerCase();

        if (!email) {
            return response.status(400).json({ error: '缺少邮箱地址' });
        }

        if (!isQQEmail(email)) {
            return response.status(400).json({ error: '必须使用QQ邮箱注册' });
        }

        const ip = getIpAddress(request, PREFER_REAL_IP_HEADER);
        await verificationLimiter.consume(`${ip}:${email}`);

        const code = generateEmailCode();
        await saveEmailCode(email, code);
        await sendVerificationEmail(email, code);
        return response.sendStatus(204);
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            return retryAfter(response, error).status(429).send({ error: '请求过于频繁，请稍后再试' });
        }

        console.error('Send verification failed:', error);
        return response.status(500).json({ error: error.message || '验证码发送失败' });
    }
});

router.post('/register', async (request, response) => {
    try {
        const handle = String(request.body.handle ?? request.body.name ?? '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
        const name = String(request.body.name ?? request.body.handle ?? '').trim();
        const passwordText = String(request.body.password ?? '');
        const email = String(request.body.email ?? '').trim().toLowerCase();
        const verificationCode = String(request.body.verificationCode ?? '').trim();
        const cardKey = String(request.body.cardKey ?? '').trim().toUpperCase();

        if (!handle || !name || !passwordText || !email || !verificationCode || !cardKey) {
            return response.status(400).json({ error: '缺少必要参数' });
        }

        if (!isQQEmail(email)) {
            return response.status(400).json({ error: '必须使用QQ邮箱注册' });
        }

        const ip = getIpAddress(request, PREFER_REAL_IP_HEADER);
        await registerLimiter.consume(`${ip}:${email}`);

        return await withUserLock(handle, async () => {
            if (!await canCreateUserAccount(handle)) {
                return response.status(409).json({ error: '用户名不可用或仍有待清除数据' });
            }
            if (!await verifyEmailCode(email, verificationCode)) {
                return response.status(400).json({ error: '验证码错误或已过期' });
            }
            if (!await verifyCardKey(cardKey)) {
                return response.status(400).json({ error: '卡密无效或已被使用' });
            }

            const salt = getPasswordSalt();
            const user = {
                handle,
                accountId: crypto.randomUUID(),
                name,
                created: Date.now(),
                password: getPasswordHash(passwordText, salt),
                salt,
                admin: false,
                enabled: true,
                email,
                lastLogin: null,
                lastActivity: null,
            };
            await storage.setItem(toKey(handle), user);
            await checkForNewContent([ensureUserDirectories(handle)], [CONTENT_TYPES.SETTINGS]);
            await markCardKeyAsUsed(cardKey, handle);
            await removeEmailCode(email);
            await registerLimiter.delete(`${ip}:${email}`);
            return response.json({ handle });
        });
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            return retryAfter(response, error).status(429).send({ error: '注册请求过于频繁，请稍后再试' });
        }

        console.error('Register failed:', error);
        return response.status(500).json({ error: error.message || '注册失败' });
    }
});

router.post('/recover-step2', async (request, response) => {
    try {
        if (typeof request.body?.handle !== 'string' || !request.body.handle || typeof request.body.code !== 'string' || !request.body.code || (request.body.newPassword !== undefined && typeof request.body.newPassword !== 'string')) {
            console.warn('Recover step 2 failed: Missing required fields');
            return response.status(400).json({ error: '缺少必要参数' });
        }

        const { handle, code, newPassword } = request.body;
        const ip = getIpAddress(request, PREFER_REAL_IP_HEADER);
        return await withUserLock(handle, async () => {
            const rateLimit = await recoverLimiter.get(ip);
            if (rateLimit !== null && rateLimit.consumedPoints > recoverLimiter.points) throw rateLimit;
            const user = await storage.getItem(toKey(handle));
            if (!user) return response.status(404).json({ error: '用户不存在' });
            if (!user.enabled || isUserPurgeBlocked(handle)) return response.status(403).json({ error: '该账号当前不可找回' });
            const recovery = MFA_CACHE.get(user.accountId);
            if (code !== recovery?.code || recovery.email !== (user.email ?? '') || recovery.version !== getAccountVersion(user)) {
                await recoverLimiter.consume(ip);
                return response.status(403).json({ error: '验证码错误' });
            }
            const previousVersion = getAccountVersion(user);
            user.salt = newPassword ? getPasswordSalt() : '';
            user.password = newPassword ? getPasswordHash(newPassword, user.salt) : '';
            await storage.setItem(toKey(handle), user);
            MFA_CACHE.remove(user.accountId);
            if (request.session?.handle === handle && request.session.version === previousVersion) {
                request.session.version = getAccountVersion(user);
            }
            await recoverLimiter.delete(ip);
            return response.sendStatus(204);
        });
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            console.error('Recover step 2 failed: Rate limited from', getIpAddress(request, PREFER_REAL_IP_HEADER));
            return retryAfter(response, error).status(429).send({ error: '尝试次数过多，请稍后再试或联系管理员' });
        }

        console.error('Recover step 2 failed:', error);
        return response.sendStatus(500);
    }
});
