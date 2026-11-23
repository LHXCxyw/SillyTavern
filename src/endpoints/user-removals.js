import express from 'express';
import { getConfigValue } from '../util.js';
import { getUserLifecycle, UserRemovalError } from '../user-lifecycle.js';
import { requireAdminMiddleware } from '../users.js';
import { getAccount } from '../account-store.js';

export const router = express.Router();

function handleRequest(action) {
    return async (request, response) => {
        if (!getConfigValue('enableUserAccounts', false, 'boolean')) return response.sendStatus(403);
        const actor = request.user?.profile;
        if (typeof actor?.accountId !== 'string' || !actor.accountId) return response.sendStatus(403);
        try {
            response.set('Cache-Control', 'no-store');
            return response.json(await action(getUserLifecycle(), request, actor));
        } catch (error) {
            if (error instanceof UserRemovalError) return response.status(error.status).json({ error: error.message });
            console.error('延期清除管理请求未能完成。');
            return response.status(500).json({ error: '操作未能完成，请稍后重试。' });
        }
    };
}

router.post('/delete/preview', requireAdminMiddleware, handleRequest((service, request, actor) => service.preview(request.body?.handles, actor)));

router.post('/delete', requireAdminMiddleware, handleRequest((service, request, actor) => {
    const body = request.body;
    if (!body || Object.keys(body).length !== 1 || typeof body.previewId !== 'string') {
        throw new UserRemovalError(400, '必须先预览再确认，旧式直接删除不受支持。');
    }
    return service.confirm(body.previewId, actor);
}));

router.get('/delete/jobs', requireAdminMiddleware, handleRequest((service, request) => {
    const page = request.query.page;
    const search = typeof request.query.search === 'string' ? request.query.search : '';
    const state = typeof request.query.state === 'string' ? request.query.state : '';
    const result = service.list(typeof page === 'string' && /^\d+$/.test(page) ? Number(page) : 1, { search, state, includeEmail: true });
    return {
        ...result,
        items: result.items.map(job => ({ ...job, name: getAccount(job.handle)?.name ?? '' })),
    };
}));

router.post('/delete/jobs/:id/cancel', requireAdminMiddleware, handleRequest((service, request, actor) => service.cancel(request.params.id, actor.accountId)));
router.post('/delete/jobs/:id/retry', requireAdminMiddleware, handleRequest((service, request, actor) => service.retry(request.params.id, actor.accountId)));
router.post('/admin/change-email', requireAdminMiddleware, handleRequest((service, request, actor) => service.changeEmail(request.body?.handle, request.body?.email, actor.accountId)));
