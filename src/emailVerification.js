import crypto from 'node:crypto';

import storage from 'node-persist';

import { renderEmailHtml, renderEmailText } from './email-templates.js';
import { normalizeNotificationAddress, sendSmtpEmail } from './smtp-service.js';

const CODE_EXPIRATION_MINUTES = 10;
const EMAIL_CODE_PREFIX = 'email_code:';

export function isQQEmail(email) {
    return /^[1-9][0-9]{4,}@qq\.com$/.test(String(email ?? '').trim().toLowerCase());
}

export function generateEmailCode() {
    return crypto.randomInt(100000, 999999).toString();
}

export async function saveEmailCode(email, code) {
    const normalizedEmail = normalizeEmail(email);
    if (!isQQEmail(normalizedEmail)) {
        throw new Error('必须使用QQ邮箱注册');
    }

    await storage.setItem(`${EMAIL_CODE_PREFIX}${normalizedEmail}`, {
        code,
        expirationTime: Date.now() + CODE_EXPIRATION_MINUTES * 60 * 1000,
    });
}

export async function verifyEmailCode(email, code) {
    const normalizedEmail = normalizeEmail(email);
    const storedData = await storage.getItem(`${EMAIL_CODE_PREFIX}${normalizedEmail}`);

    if (!storedData) {
        return false;
    }

    if (Date.now() > storedData.expirationTime) {
        await removeEmailCode(normalizedEmail);
        return false;
    }

    return String(code ?? '') === storedData.code;
}

export async function removeEmailCode(email) {
    await storage.removeItem(`${EMAIL_CODE_PREFIX}${normalizeEmail(email)}`);
}

export async function sendVerificationEmail(email, code) {
    await sendEmail({
        email,
        code,
        subject: '验证码',
        heading: '验证您的邮箱',
        intro: '请使用以下验证码完成验证：',
        warning: '如果您没有请求此验证码，请忽略此邮件。',
    });
}

export async function sendPasswordResetEmail(email, code) {
    await sendEmail({
        email,
        code,
        subject: '密码重置验证码',
        heading: '重置密码',
        intro: '我们收到了您的密码重置请求。请使用以下验证码完成密码重置：',
        warning: '如果您没有请求重置密码，请立即登录您的账户并修改密码以确保账户安全。',
    });
}

async function sendEmail({ email, code, subject, heading, intro, warning }) {
    const normalizedEmail = normalizeNotificationAddress(String(email ?? ''))?.toLowerCase();
    if (!isQQEmail(normalizedEmail)) {
        throw new Error('必须使用QQ邮箱');
    }

    await sendSmtpEmail({
        email: normalizedEmail,
        subject,
        text: renderEmailText({
            intro: `您的验证码是：${code}。`,
            note: `此验证码将在${CODE_EXPIRATION_MINUTES}分钟后失效。`,
            warning,
        }),
        html: renderEmailHtml({
            heading,
            intro,
            code,
            note: `此验证码将在${CODE_EXPIRATION_MINUTES}分钟后失效。`,
            warning,
        }),
    });
}

function normalizeEmail(email) {
    return String(email ?? '').trim().toLowerCase();
}
