import { isIP } from 'node:net';

import nodemailer from 'nodemailer';
import storage from 'node-persist';

import { getConfigValue } from './util.js';

const SETTINGS_KEY = 'smtp_settings';
const ENV_FIELDS = {
    host: 'SMTP_HOST',
    port: 'SMTP_PORT',
    secure: 'SMTP_SECURE',
    user: 'SMTP_USER',
    from: 'SMTP_FROM',
};
const FIELDS = Object.keys(ENV_FIELDS);
const TEST_INTERVAL_MS = 60_000;
const CONTROL_CHAR = /[\p{Cc}\u2028\u2029]/u;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i;
let nextTestAt = 0;

function smtpError(code, retryable = false, uncertain = false) {
    return Object.assign(new Error(code), { code, retryable, uncertain });
}

export function normalizeNotificationAddress(value) {
    if (typeof value !== 'string' || CONTROL_CHAR.test(value)) {
        return null;
    }
    const address = value.trim();
    const at = address.indexOf('@');
    const local = address.slice(0, at);
    const domain = address.slice(at + 1);
    if (at < 1 || at > 64 || address.length > 254 || !LOCAL_PART.test(local) || !DOMAIN.test(domain)) {
        return null;
    }
    return `${local}@${domain.toLowerCase()}`;
}

function normalizeFrom(value) {
    if (typeof value !== 'string' || CONTROL_CHAR.test(value) || value.length > 512) {
        return null;
    }
    const address = normalizeNotificationAddress(value);
    if (address) {
        return address;
    }
    // 兼容历史配置中的单个发件人显示名，不接受地址列表或群组。
    const named = /^("[^"\\]*"|[^"<>:;,\\]+?)\s*<([^<>]+)>$/.exec(value.trim());
    const mailbox = named && normalizeNotificationAddress(named[2]);
    return mailbox ? `${named[1]} <${mailbox}>` : null;
}

function normalizeSetting(field, value) {
    if (field === 'port') {
        const port = typeof value === 'string' && !CONTROL_CHAR.test(value) && /^\d+$/.test(value) ? Number(value) : value;
        return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
    }
    if (field === 'secure') {
        if (typeof value === 'boolean') {
            return value;
        }
        if (typeof value === 'string' && !CONTROL_CHAR.test(value)) {
            const token = value.trim().toLowerCase();
            if (['1', 'true', 'yes', 'on'].includes(token)) {
                return true;
            }
            if (['0', 'false', 'no', 'off'].includes(token)) {
                return false;
            }
        }
        return null;
    }
    if (typeof value !== 'string' || CONTROL_CHAR.test(value)) {
        return null;
    }
    const text = value.trim();
    if (field === 'host') {
        const hostname = text.toLowerCase();
        return isIP(hostname) || (hostname.length <= 253 && DOMAIN.test(`${hostname}.invalid`)) ? hostname : null;
    }
    if (field === 'user') {
        return text.length <= 254 ? text : null;
    }
    return text === '' ? '' : normalizeFrom(text);
}

function deploymentEndpoint() {
    return {
        host: getConfigValue('smtp.host', ''),
        port: getConfigValue('smtp.port', 465),
        secure: getConfigValue('smtp.secure', true),
    };
}

function endpointAllowed(settings, defaults) {
    const list = getConfigValue('smtp.allowedEndpoints', undefined);
    const deployment = {
        host: process.env.SMTP_HOST ?? defaults.host,
        port: process.env.SMTP_PORT ?? defaults.port,
        secure: process.env.SMTP_SECURE ?? defaults.secure,
    };
    const endpoints = list == null || (Array.isArray(list) && list.length === 0) ? [deployment] : list;
    if (!Array.isArray(endpoints) || !settings.host || settings.port === null || settings.secure === null) {
        return false;
    }
    return endpoints.some(endpoint => endpoint && ['host', 'port', 'secure'].every(field =>
        Object.hasOwn(endpoint, field) && normalizeSetting(field, endpoint[field]) === settings[field]));
}

function getTestRecipient() {
    return normalizeNotificationAddress(process.env.SMTP_TEST_RECIPIENT ?? getConfigValue('smtp.testRecipient', ''));
}

function resolveSettings(saved) {
    const defaults = deploymentEndpoint();
    const fallback = { ...defaults, user: getConfigValue('smtp.user', ''), from: getConfigValue('smtp.from', '') };
    const settings = {};
    const locked = {};
    for (const field of FIELDS) {
        const env = process.env[ENV_FIELDS[field]];
        locked[field] = env !== undefined;
        settings[field] = normalizeSetting(field, env ?? saved?.[field] ?? fallback[field]);
    }
    if (settings.from === '' && !locked.from) {
        settings.from = normalizeFrom(settings.user);
    }
    const allowed = endpointAllowed(settings, defaults);
    return { settings, locked, allowed };
}

async function readSavedSettings() {
    try {
        return (await storage.getItem(SETTINGS_KEY)) ?? {};
    } catch {
        throw smtpError('SMTP_SETTINGS_UNAVAILABLE', true);
    }
}

function settingsView({ settings, locked, allowed }) {
    const passwordConfigured = Boolean(process.env.SMTP_PASS);
    return {
        settings: { ...settings, host: settings.host ?? '', user: settings.user ?? '', from: settings.from ?? '' },
        locked,
        configured: Boolean(allowed && settings.user && settings.from && passwordConfigured),
        passwordConfigured,
        testRecipientConfigured: Boolean(getTestRecipient()),
    };
}

export async function getSmtpSettings() {
    return settingsView(resolveSettings(await readSavedSettings()));
}

export async function saveSmtpSettings(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(field => !FIELDS.includes(field))) {
        throw smtpError('SMTP_INVALID_SETTINGS');
    }
    const previous = await readSavedSettings();
    const current = resolveSettings(previous);
    const saved = {};
    for (const field of FIELDS) {
        if (Object.hasOwn(previous, field)) {
            saved[field] = previous[field];
        }
        if (!Object.hasOwn(input, field)) {
            continue;
        }
        const value = normalizeSetting(field, input[field]);
        if (value === null) {
            throw smtpError('SMTP_INVALID_SETTINGS');
        }
        if (current.locked[field]) {
            if (value !== current.settings[field]) {
                throw smtpError('SMTP_SETTING_LOCKED');
            }
        } else {
            saved[field] = value;
        }
    }
    const updated = resolveSettings(saved);
    if (!updated.allowed) {
        throw smtpError('SMTP_ENDPOINT_NOT_ALLOWED');
    }
    try {
        await storage.setItem(SETTINGS_KEY, saved);
    } catch {
        throw smtpError('SMTP_SETTINGS_UNAVAILABLE', true);
    }
    return settingsView(updated);
}

function classifyDeliveryError(error) {
    const status = error?.responseCode;
    if (Number.isInteger(status) && status >= 400 && status <= 599) {
        return smtpError('SMTP_REJECTED', status < 500);
    }
    if (error?.code === 'EAUTH' || error?.code === 'ETLS') {
        return smtpError('SMTP_HANDSHAKE_FAILED');
    }
    // 连接断开或超时可能发生在服务端接受 DATA 后、客户端收到确认前。
    return smtpError('SMTP_DELIVERY_UNCERTAIN', false, true);
}

async function getDeliverySettings() {
    const { settings, allowed } = resolveSettings(await readSavedSettings());
    const pass = process.env.SMTP_PASS;
    if (!allowed || !settings.user || !settings.from || !pass) {
        throw smtpError('SMTP_NOT_CONFIGURED');
    }
    return { ...settings, pass };
}

async function deliver({ host, port, secure, user, pass, from }, to, { subject, text, html }) {
    let result;
    try {
        const transport = nodemailer.createTransport({
            host,
            port,
            secure,
            requireTLS: !secure,
            tls: { rejectUnauthorized: true },
            auth: { user, pass },
            connectionTimeout: 10_000,
            greetingTimeout: 10_000,
            socketTimeout: 30_000,
            dnsTimeout: 10_000,
            disableFileAccess: true,
            disableUrlAccess: true,
        });
        result = await transport.sendMail({ from, to, subject, text, html });
    } catch (error) {
        throw classifyDeliveryError(error);
    }
    const accepted = Array.isArray(result?.accepted) && result.accepted.some(address => normalizeNotificationAddress(address) === to);
    const rejected = Array.isArray(result?.rejected) ? result.rejected : null;
    if (accepted && rejected?.length === 0) {
        return { acceptedAt: Date.now() };
    }
    if (!accepted && rejected?.some(address => normalizeNotificationAddress(address) === to)) {
        const rejection = Array.isArray(result.rejectedErrors) && result.rejectedErrors.find(error => normalizeNotificationAddress(error?.recipient) === to);
        const status = rejection?.responseCode;
        throw smtpError('SMTP_REJECTED', Number.isInteger(status) && status >= 400 && status < 500);
    }
    throw smtpError('SMTP_DELIVERY_UNCERTAIN', false, true);
}

export async function sendSmtpEmail({ email, subject, text, html }) {
    const to = normalizeNotificationAddress(email);
    if (!to) {
        throw smtpError('SMTP_INVALID_RECIPIENT');
    }
    if (typeof subject !== 'string' || CONTROL_CHAR.test(subject)) {
        throw smtpError('SMTP_INVALID_MESSAGE');
    }
    return deliver(await getDeliverySettings(), to, { subject, text, html });
}

function getPublicUrl() {
    const raw = getConfigValue('userLifecycle.publicUrl', '');
    if (typeof raw !== 'string' || CONTROL_CHAR.test(raw) || !/^https?:\/\//i.test(raw.trim())) {
        return null;
    }
    try {
        const url = new URL(raw.trim());
        return url.hostname && !url.username && !url.password && !url.search && !url.hash ? url.href : null;
    } catch {
        return null;
    }
}

export async function sendAccountRemovalNotice({ email }) {
    const url = getPublicUrl();
    return sendSmtpEmail({
        email,
        subject: '账户移除通知',
        text: '自本通知由邮件服务器（SMTP）接受交接起 7 天后，您的账户将被移除。'
            + '\n请登录站点，在账户设置中查看确切截止时间，并在截止前选择“下载备份”保存您的数据。'
            + (url ? `\n站点：${url}` : ''),
    });
}

export async function sendSmtpTestEmail() {
    const to = getTestRecipient();
    if (!to) {
        throw smtpError('SMTP_TEST_RECIPIENT_NOT_CONFIGURED');
    }
    const settings = await getDeliverySettings();
    const now = Date.now();
    if (now < nextTestAt) {
        throw smtpError('SMTP_TEST_RATE_LIMITED', true);
    }
    nextTestAt = now + TEST_INTERVAL_MS;
    await deliver(settings, to, { subject: 'SMTP 配置测试', text: '这是一封站点管理员发起的 SMTP 测试邮件。' });
}
