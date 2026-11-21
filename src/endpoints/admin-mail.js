import express from 'express';

import { getSmtpSettings, saveSmtpSettings, sendSmtpTestEmail } from '../smtp-service.js';
import { requireAdminMiddleware } from '../users.js';
import { getConfigValue } from '../util.js';

export const router = express.Router();

const SETTINGS_PATH = '/admin/mail-settings';
router.use(SETTINGS_PATH, requireAdminMiddleware, (_request, response, next) => {
    if (!getConfigValue('enableUserAccounts', false, 'boolean')) return response.sendStatus(403);
    response.set('Cache-Control', 'no-store');
    return next();
});
const ERROR_STATUS = new Map([
    ['SMTP_INVALID_SETTINGS', 400],
    ['SMTP_SETTING_LOCKED', 400],
    ['SMTP_ENDPOINT_NOT_ALLOWED', 400],
    ['SMTP_NOT_CONFIGURED', 409],
    ['SMTP_TEST_RECIPIENT_NOT_CONFIGURED', 409],
    ['SMTP_TEST_RATE_LIMITED', 429],
    ['SMTP_SETTINGS_UNAVAILABLE', 503],
    ['SMTP_REJECTED', 502],
    ['SMTP_HANDSHAKE_FAILED', 502],
    ['SMTP_DELIVERY_UNCERTAIN', 502],
]);

function sendError(response, error) {
    const status = ERROR_STATUS.get(error?.code);
    if (!status) {
        return response.status(500).json({ code: 'SMTP_INTERNAL_ERROR' });
    }
    return response.status(status).json({ code: error.code, retryable: error.retryable, uncertain: error.uncertain });
}

// 挂载时沿用上游的会话与 CSRF 中间件。
router.get(SETTINGS_PATH, async (_request, response) => {
    try {
        return response.json(await getSmtpSettings());
    } catch (error) {
        return sendError(response, error);
    }
});

router.post(SETTINGS_PATH, async (request, response) => {
    try {
        return response.json(await saveSmtpSettings(request.body));
    } catch (error) {
        return sendError(response, error);
    }
});

router.post(`${SETTINGS_PATH}/test`, async (request, response) => {
    const body = request.body;
    if ((body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)) ||
        Object.keys(request.query).length) {
        return response.status(400).json({ code: 'SMTP_INVALID_SETTINGS' });
    }
    try {
        await sendSmtpTestEmail();
        return response.sendStatus(204);
    } catch (error) {
        return sendError(response, error);
    }
});
