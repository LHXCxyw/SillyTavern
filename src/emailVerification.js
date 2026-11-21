import crypto from 'node:crypto';

import storage from 'node-persist';

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
        subject: '咸鱼傻酒馆验证码',
        title: '欢迎来到咸鱼傻酒馆',
        intro: '请使用以下验证码完成验证：',
        warning: '如果您没有请求此验证码，请忽略此邮件。',
    });
}

export async function sendPasswordResetEmail(email, code) {
    await sendEmail({
        email,
        code,
        subject: '咸鱼傻酒馆 - 密码重置验证码',
        title: '咸鱼傻酒馆 - 密码重置',
        intro: '我们收到了您的密码重置请求。请使用以下验证码完成密码重置：',
        warning: '如果您没有请求重置密码，请立即登录您的账户并修改密码以确保账户安全。',
    });
}

async function sendEmail({ email, code, subject, title, intro, warning }) {
    const normalizedEmail = normalizeNotificationAddress(String(email ?? ''))?.toLowerCase();
    if (!isQQEmail(normalizedEmail)) {
        throw new Error('必须使用QQ邮箱');
    }

    await sendSmtpEmail({
        email: normalizedEmail,
        subject,
        text: `您的验证码是：${code}。此验证码将在${CODE_EXPIRATION_MINUTES}分钟后过期。`,
        html: buildEmailHtml({ code, title, intro, warning }),
    });
}

function buildEmailHtml({ code, title, intro, warning }) {
    return `<body style="margin:0;padding:0;font-family:Arial,sans-serif;background-color:#0e0e0e;"><table border="0" cellpadding="0" cellspacing="0" width="100%" style="min-width:100%;background-color:#0e0e0e;"><tr><td align="center" valign="top" style="padding:20px 10px;"><table border="0" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background-color:#171717;border-radius:10px;box-shadow:0 0 20px rgba(0,0,0,.5);"><tr><td align="center" valign="top" style="padding:20px;color:#fff;"><h2 style="margin-top:0;margin-bottom:20px;">${title}</h2><h1 style="margin-bottom:20px;">您的验证码</h1><p style="margin-bottom:15px;">${intro}</p><div style="font-size:36px;font-weight:bold;letter-spacing:5px;color:#86e3ce;background-color:#2a2a2a;padding:10px;border-radius:5px;margin:20px 0;">${code}</div><p style="margin-bottom:15px;">此验证码将在${CODE_EXPIRATION_MINUTES}分钟后失效。</p><p style="margin-bottom:15px;color:#ff9999;">${warning}</p></td></tr></table></td></tr></table></body>`;
}

function normalizeEmail(email) {
    return String(email ?? '').trim().toLowerCase();
}
