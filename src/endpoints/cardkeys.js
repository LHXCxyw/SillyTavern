import express from 'express';

import {
    bulkDeleteCardKeys,
    deleteCardKey,
    generateCardKeys,
    getAllCardKeys,
    getCardKeyStats,
    normalizeCardKey,
    verifyCardKey,
} from '../cardkeys.js';
import { requireAdminMiddleware } from '../users.js';

export const router = express.Router();

router.use(requireAdminMiddleware);

router.post('/create', async (request, response) => {
    try {
        const count = Number(request.body.count);
        const batchName = String(request.body.batchName ?? '').trim();

        if (!Number.isInteger(count) || !batchName) {
            return response.status(400).json({ error: '缺少必要参数' });
        }

        if (count <= 0 || count > 100) {
            return response.status(400).json({ error: '卡密数量必须在1-100之间' });
        }

        const creator = request.user.profile.name || request.user.profile.handle;
        const codes = await generateCardKeys(count, batchName, creator);
        return response.json({ codes });
    } catch (error) {
        console.error('创建卡密失败:', error);
        return response.status(500).json({ error: '服务器内部错误' });
    }
});

router.get('/list', async (request, response) => {
    try {
        const status = request.query.status || 'all';
        let cardKeys = await getAllCardKeys();

        if (status === 'used') {
            cardKeys = cardKeys.filter(key => key.status === 'used');
        } else if (status === 'unused') {
            cardKeys = cardKeys.filter(key => key.status === 'unused');
        }

        const stats = await getCardKeyStats();
        return response.json({ cardKeys, stats });
    } catch (error) {
        console.error('获取卡密列表失败:', error);
        return response.status(500).json({ error: '服务器内部错误' });
    }
});

router.post('/verify', async (request, response) => {
    try {
        const code = normalizeCardKey(request.body.code);

        if (!code) {
            return response.status(400).json({ error: '缺少必要参数' });
        }

        return response.json({ valid: await verifyCardKey(code) });
    } catch (error) {
        console.error('验证卡密失败:', error);
        return response.status(500).json({ error: '服务器内部错误' });
    }
});

router.delete('/delete/:code', async (request, response) => {
    try {
        const code = normalizeCardKey(request.params.code);

        if (!code) {
            return response.status(400).json({ error: '缺少必要参数' });
        }

        return response.json({ success: await deleteCardKey(code) });
    } catch (error) {
        console.error('删除卡密失败:', error);
        return response.status(500).json({ error: '服务器内部错误' });
    }
});

router.post('/bulk_delete', async (request, response) => {
    try {
        const codes = request.body.codes;

        if (!Array.isArray(codes) || codes.length === 0) {
            return response.status(400).json({ error: '缺少必要参数' });
        }

        return response.json(await bulkDeleteCardKeys(codes.map(normalizeCardKey)));
    } catch (error) {
        console.error('批量删除卡密失败:', error);
        return response.status(500).json({ error: '服务器内部错误' });
    }
});

router.get('/stats', async (_request, response) => {
    try {
        return response.json(await getCardKeyStats());
    } catch (error) {
        console.error('获取卡密统计信息失败:', error);
        return response.status(500).json({ error: '服务器内部错误' });
    }
});

export const publicRouter = express.Router();

publicRouter.post('/verify', async (request, response) => {
    try {
        const code = normalizeCardKey(request.body.code);

        if (!code) {
            return response.status(400).json({ error: '缺少必要参数' });
        }

        return response.json({ valid: await verifyCardKey(code) });
    } catch (error) {
        console.error('验证卡密失败:', error);
        return response.status(500).json({ error: '服务器内部错误' });
    }
});
