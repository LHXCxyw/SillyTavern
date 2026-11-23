import { isIP } from 'node:net';

import nodemailer from 'nodemailer';
import storage from 'node-persist';

import { getConfigValue } from './util.js';
import { formatEmailSubject, renderEmailHtml, renderEmailText } from './email-templates.js';

const SETTINGS_KEY = 'smtp_settings';
const ENV_FIELDS = {
    host: 'SMTP_HOST',
    port: 'SMTP_PORT',
    secure: 'SMTP_SECURE',
    user: 'SMTP_USER',
    from: 'SMTP_FROM',
};
const FIELDS = Object.keys(ENV_FIELDS);
const TEST_RECIPIENT_FIELD = 'testRecipient';
const SAVE_FIELDS = [...FIELDS, TEST_RECIPIENT_FIELD];
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

async function getTestRecipient() {
    const { testRecipient, testRecipientValid } = resolveSettings(await readSavedSettings());
    return testRecipientValid ? testRecipient : null;
}

function getSmtpPassword() {
    const pass = process.env.SMTP_PASS || getConfigValue('smtp.pass', '');
    return typeof pass === 'string' ? pass : '';
}

function normalizeTestRecipient(value) {
    if (value == null || value === '') {
        return '';
    }
    if (typeof value !== 'string' || CONTROL_CHAR.test(value)) {
        return null;
    }
    const text = value.trim();
    return text === '' ? '' : normalizeNotificationAddress(text);
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
    // 测试收件地址可在管理面板保存；环境变量优先且视为锁定。
    const testEnv = process.env.SMTP_TEST_RECIPIENT;
    const testRecipientLocked = testEnv !== undefined;
    const testRecipient = normalizeTestRecipient(testEnv ?? saved?.[TEST_RECIPIENT_FIELD] ?? getConfigValue('smtp.testRecipient', ''));
    return {
        settings,
        locked,
        allowed,
        testRecipient,
        testRecipientLocked,
        testRecipientValid: testRecipient !== null,
    };
}

async function readSavedSettings() {
    try {
        return (await storage.getItem(SETTINGS_KEY)) ?? {};
    } catch {
        throw smtpError('SMTP_SETTINGS_UNAVAILABLE', true);
    }
}

function settingsView({ settings, locked, allowed, testRecipient, testRecipientLocked, testRecipientValid }) {
    const passwordConfigured = Boolean(getSmtpPassword());
    return {
        settings: {
            ...settings,
            host: settings.host ?? '',
            user: settings.user ?? '',
            from: settings.from ?? '',
            testRecipient: testRecipientValid ? testRecipient : '',
        },
        locked: { ...locked, testRecipient: testRecipientLocked },
        configured: Boolean(allowed && settings.user && settings.from && passwordConfigured),
        passwordConfigured,
        testRecipientConfigured: Boolean(testRecipientValid && testRecipient),
    };
}

export async function getSmtpSettings() {
    return settingsView(resolveSettings(await readSavedSettings()));
}

export async function saveSmtpSettings(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(field => !SAVE_FIELDS.includes(field))) {
        throw smtpError('SMTP_INVALID_SETTINGS');
    }
    const previous = await readSavedSettings();
    const current = resolveSettings(previous);
    const saved = {};
    if (Object.hasOwn(previous, TEST_RECIPIENT_FIELD)) {
        saved[TEST_RECIPIENT_FIELD] = previous[TEST_RECIPIENT_FIELD];
    }
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
    if (Object.hasOwn(input, TEST_RECIPIENT_FIELD)) {
        const value = normalizeTestRecipient(input[TEST_RECIPIENT_FIELD]);
        if (value === null) {
            throw smtpError('SMTP_INVALID_SETTINGS');
        }
        if (current.testRecipientLocked) {
            if (value !== current.testRecipient) {
                throw smtpError('SMTP_SETTING_LOCKED');
            }
        } else {
            saved[TEST_RECIPIENT_FIELD] = value;
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
    const pass = getSmtpPassword();
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
    return deliver(await getDeliverySettings(), to, { subject: formatEmailSubject(subject), text, html });
}

export async function sendAccountRemovalNotice({ email }) {
    const intro = '自本通知由邮件服务器（SMTP）接受交接起 7 天后，您的账户将被移除。';
    const note = '请登录站点，在账户设置中查看确切截止时间，并在截止前选择“下载备份”保存您的数据。';
    const warning = '保留期不会因登录而延长，截止后账户与备份将不可访问。';
    return sendSmtpEmail({
        email,
        subject: '账户移除通知',
        text: renderEmailText({ intro, note, warning }),
        html: renderEmailHtml({
            heading: '账户移除通知',
            intro,
            note,
            warning,
        }),
    });
}

export async function sendAccountRemovalCancellationNotice({ email }) {
    const intro = '管理员已撤销该账户的移除任务，账号将保持不变。';
    const note = '您可以继续正常登录并使用账户；如对本次操作有疑问，可通过交流群联系管理员。';
    return sendSmtpEmail({
        email,
        subject: '账户移除已取消',
        text: renderEmailText({ intro, note }),
        html: renderEmailHtml({
            heading: '账户移除已取消',
            intro,
            note,
        }),
    });
}

export async function sendSmtpTestEmail() {
    const to = await getTestRecipient();
    if (!to) {
        throw smtpError('SMTP_TEST_RECIPIENT_NOT_CONFIGURED');
    }
    const settings = await getDeliverySettings();
    const now = Date.now();
    if (now < nextTestAt) {
        throw smtpError('SMTP_TEST_RATE_LIMITED', true);
    }
    nextTestAt = now + TEST_INTERVAL_MS;
    await deliver(settings, to, {
        subject: formatEmailSubject('SMTP 配置测试'),
        text: renderEmailText({
            intro: '这是一封站点管理员发起的 SMTP 测试邮件。',
            note: '收到此邮件说明当前 SMTP 参数、授权码与 TLS 连接可用。',
        }),
        html: renderEmailHtml({
            heading: 'SMTP 配置测试',
            intro: '这是一封站点管理员发起的 SMTP 测试邮件。',
            note: '收到此邮件说明当前 SMTP 参数、授权码与 TLS 连接可用。',
        }),
    });
}
