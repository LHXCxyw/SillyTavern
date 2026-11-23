import crypto from 'node:crypto';

import storage from 'node-persist';
import express from 'express';
import lodash from 'lodash';
import { checkForNewContent, CONTENT_TYPES } from './content-manager.js';
import { toKey, requireAdminMiddleware, getUserAvatar, getPasswordSalt, getPasswordHash, canCreateUserAccount, ensureUserDirectories, saveUserRecord } from '../users.js';
import { getAllAccounts } from '../account-store.js';
import { DEFAULT_USER } from '../constants.js';
import { parseAdminUserQuery } from '../admin-user-list.js';
import { getUserRemoval, hasActiveUserRemoval } from '../user-lifecycle.js';
import { isUserPurgeBlocked, withUserLock } from '../user-operation-state.js';
import { normalizeNotificationAddress } from '../smtp-service.js';

export const router = express.Router();

function slugify(text) {
    return lodash.deburr(text.toLowerCase().trim()).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

router.post('/get', requireAdminMiddleware, async (request, response) => {
    let query;
    try {
        query = parseAdminUserQuery(request.body ?? {});
    } catch (error) {
        return response.status(400).json({ error: error.message });
    }
    try {
        const { page, pageSize, includeAvatars, match, compare } = query;
        const users = getAllAccounts();
        const filtered = users.map(user => ({ user, removal: getUserRemoval(user.handle) }))
            .filter(({ user, removal }) => match(user, removal))
            .sort((first, second) => compare(first.user, second.user));
        const total = filtered.length;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const safePage = Math.min(page, totalPages);
        const items = await Promise.all(filtered.slice((safePage - 1) * pageSize, safePage * pageSize).map(async ({ user, removal }) => ({
            handle: user.handle,
            name: user.name,
            avatar: (includeAvatars && !isUserPurgeBlocked(user.handle) && await getUserAvatar(user.handle)) || 'img/ai4.png',
            admin: user.admin,
            enabled: user.enabled && !isUserPurgeBlocked(user.handle),
            created: user.created,
            password: Boolean(user.password),
            email: user.email ?? '',
            lastLogin: Number.isFinite(user.lastLogin) ? user.lastLogin : null,
            lastActivity: user.lastActivity ?? null,
            deletionProtected: user.admin || user.handle === DEFAULT_USER.handle || user.handle === request.user.profile.handle,
            removal,
        })));
        return response.json({ items, total, page: safePage, pageSize, totalPages });
    } catch (error) {
        console.error('读取用户列表失败:', error);
        return response.sendStatus(500);
    }
});

/**
 * 读取单个账户头像。管理员列表只在图像进入可见区域时请求此接口，
 * 避免把 base64 一次性塞进列表响应。
 */
router.get('/avatar/:handle', requireAdminMiddleware, async (request, response) => {
    const handle = String(request.params.handle ?? '').trim();
    if (!handle || handle.length > 255 || /[\\/]/.test(handle) || handle.includes('..')) {
        return response.sendStatus(400);
    }
    try {
        const user = await storage.getItem(toKey(handle));
        if (!user || isUserPurgeBlocked(handle)) {
            return response.sendStatus(404);
        }
        const avatar = await getUserAvatar(handle);
        const match = typeof avatar === 'string' ? /^data:([^;,]+);base64,(.+)$/s.exec(avatar) : null;
        if (!match) {
            return response.sendStatus(404);
        }
        response.set('Cache-Control', 'private, no-store');
        response.set('X-Content-Type-Options', 'nosniff');
        response.type(match[1]);
        return response.send(Buffer.from(match[2], 'base64'));
    } catch (error) {
        console.error('读取用户头像失败:', error);
        return response.sendStatus(500);
    }
});

const accountActions = {
    disable: (user, actor) => {
        if (user.handle === actor.handle) return '不能停用自己的账号';
        user.enabled = false;
    },
    enable: (user) => { user.enabled = true; },
    promote: (user) => {
        if (hasActiveUserRemoval(user.handle)) return '请先撤销该用户的清除任务，再提升权限';
        user.admin = true;
    },
    demote: (user, actor) => {
        if (user.handle === actor.handle) return '不能降低自己的权限';
        user.admin = false;
    },
    'change-password-admin': (user, _actor, body) => {
        if (body.password !== undefined && typeof body.password !== 'string') return '密码格式无效';
        user.salt = body.password ? getPasswordSalt() : '';
        user.password = body.password ? getPasswordHash(body.password, user.salt) : '';
    },
};

for (const [action, mutate] of Object.entries(accountActions)) {
    router.post(`/${action}`, requireAdminMiddleware, async (request, response) => {
        const handle = request.body?.handle;
        if (typeof handle !== 'string' || !handle) return response.status(400).json({ error: '用户名无效' });
        try {
            return await withUserLock(handle, async () => {
                const user = await storage.getItem(toKey(handle));
                if (!user) return response.status(404).json({ error: '账号不存在' });
                if (isUserPurgeBlocked(handle)) return response.status(409).json({ error: '账号已到清除截止时间' });
                const error = mutate(user, request.user.profile, request.body);
                if (error) return response.status(409).json({ error });
                await saveUserRecord(user);
                return response.sendStatus(204);
            });
        } catch (error) {
            console.error('更新账号失败:', error);
            return response.status(500).json({ error: '更新账号失败' });
        }
    });
}

router.post('/create', requireAdminMiddleware, async (request, response) => {
    const { handle: rawHandle, name, password, email, admin } = request.body ?? {};
    if (typeof rawHandle !== 'string' || typeof name !== 'string' || !name.trim() || (password !== undefined && typeof password !== 'string')) {
        return response.status(400).json({ error: '请填写有效的用户名、显示名和密码' });
    }
    const handle = slugify(rawHandle);
    const address = email === undefined || email === '' ? '' : normalizeNotificationAddress(email);
    if (!handle || address === null) return response.status(400).json({ error: '用户名或邮箱格式无效' });
    try {
        return await withUserLock(handle, async () => {
            if (!await canCreateUserAccount(handle) || hasActiveUserRemoval(handle)) {
                return response.status(409).json({ error: '用户名不可用或仍有待清除数据' });
            }
            const salt = getPasswordSalt();
            const user = {
                handle,
                accountId: crypto.randomUUID(),
                name: name.trim(),
                created: Date.now(),
                password: password ? getPasswordHash(password, salt) : '',
                salt,
                admin: Boolean(admin),
                enabled: true,
                email: address,
            };
            await checkForNewContent([ensureUserDirectories(handle)], [CONTENT_TYPES.SETTINGS], { strict: true });
            await saveUserRecord(user);
            return response.json({ handle });
        });
    } catch (error) {
        console.error('创建账号失败:', error);
        return response.status(500).json({ error: '创建账号失败' });
    }
});

router.post('/slugify', requireAdminMiddleware, (request, response) => {
    if (typeof request.body?.text !== 'string' || !request.body.text) {
        return response.status(400).json({ error: '缺少名称' });
    }
    return response.send(slugify(request.body.text));
});
