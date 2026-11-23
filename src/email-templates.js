import { getConfigValue } from './util.js';

const DEFAULT_SITE_NAME = '咸鱼傻酒馆';
const DEFAULT_QQ_GROUP = '745442628';
const CONTROL_CHAR = /[\p{Cc}\u2028\u2029]/u;

/**
 * 转义 HTML 文本。
 * @param {unknown} value 原始值
 * @returns {string} 转义后的文本
 */
export function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * 读取站点名称，用于邮件标题前缀和页眉。
 * @returns {string} 站点名
 */
export function getSiteName() {
    const value = getConfigValue('site.name', DEFAULT_SITE_NAME);
    const text = typeof value === 'string' ? value.trim() : '';
    return text || DEFAULT_SITE_NAME;
}

/**
 * 读取交流群号，非纯数字视为未配置。
 * @returns {string} 群号，未配置时为空字符串
 */
export function getQqGroup() {
    const value = getConfigValue('site.qqGroup', DEFAULT_QQ_GROUP);
    const text = typeof value === 'string' ? value.trim() : '';
    return /^\d{5,12}$/.test(text) ? text : '';
}

/**
 * 读取站点地址。优先 `site.url`，其次 `userLifecycle.publicUrl`。
 * @returns {string|null} 合法地址，未配置或格式不安全时为 null
 */
export function getSiteUrl() {
    const raw = getConfigValue('site.url', '') || getConfigValue('userLifecycle.publicUrl', '');
    if (typeof raw !== 'string' || CONTROL_CHAR.test(raw)) {
        return null;
    }
    try {
        const url = new URL(raw.trim());
        const valid = ['http:', 'https:'].includes(url.protocol)
            && Boolean(url.hostname)
            && !url.username
            && !url.password
            && !url.search
            && !url.hash;
        return valid ? url.href : null;
    } catch {
        return null;
    }
}

/**
 * 给邮件标题加上站点名前缀，已带前缀时不重复添加。
 * @param {string} subject 原始标题
 * @returns {string} 带前缀的标题
 */
export function formatEmailSubject(subject) {
    const site = getSiteName();
    const text = String(subject ?? '').trim();
    if (!text) {
        return site;
    }
    const prefix = `【${site}】`;
    return text.startsWith(prefix) ? text : `${prefix}${text}`;
}

/**
 * 渲染统一风格邮件 HTML。
 * 站点名、跳转按钮、交流群与页脚由模板统一生成。
 * @param {{title?: string, heading?: string, intro: string, note?: string, code?: string, warning?: string, footer?: string, buttonLabel?: string}} options 内容
 * @returns {string} HTML 字符串
 */
export function renderEmailHtml(options) {
    const site = getSiteName();
    const {
        title = site,
        heading = '',
        intro = '',
        note = '',
        code = '',
        warning = '',
        footer = `本邮件由${site}自动发送，请勿直接回复。`,
        buttonLabel = `进入${site}`,
    } = options;

    const url = getSiteUrl();
    const group = getQqGroup();

    const headingBlock = heading
        ? `<h1 style="margin:0 0 20px;font-size:24px;font-weight:600;color:#ffffff;">${escapeHtml(heading)}</h1>`
        : '';
    const codeBlock = code
        ? `<div style="font-size:36px;font-weight:bold;letter-spacing:5px;color:#86e3ce;background-color:#2a2a2a;padding:14px;border-radius:6px;margin:20px 0;">${escapeHtml(code)}</div>`
        : '';
    const noteBlock = note
        ? `<p style="margin:0 0 15px;color:#d8d8d8;line-height:1.6;">${escapeHtml(note)}</p>`
        : '';
    const warningBlock = warning
        ? `<p style="margin:0 0 15px;color:#ff9999;line-height:1.6;">${escapeHtml(warning)}</p>`
        : '';
    const buttonBlock = url
        ? '<table border="0" cellpadding="0" cellspacing="0" style="margin:22px 0 0;">'
        + '<tr><td align="center" bgcolor="#86e3ce" style="border-radius:6px;">'
        + `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 30px;font-size:15px;font-weight:600;color:#0e0e0e;text-decoration:none;">${escapeHtml(buttonLabel)}</a>`
        + '</td></tr></table>'
        : '';
    const groupBlock = group
        ? `<p style="margin:18px 0 0;color:#d8d8d8;line-height:1.6;">交流群：<strong style="color:#ffffff;letter-spacing:1px;">${escapeHtml(group)}</strong></p>`
        : '';
    const footerBlock = footer
        ? `<p style="margin:20px 0 0;color:#8a8a8a;font-size:12px;line-height:1.5;">${escapeHtml(footer)}</p>`
        : '';

    return '<body style="margin:0;padding:0;font-family:Arial,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;background-color:#0e0e0e;">'
        + '<table border="0" cellpadding="0" cellspacing="0" width="100%" style="min-width:100%;background-color:#0e0e0e;">'
        + '<tr><td align="center" valign="top" style="padding:20px 10px;">'
        + '<table border="0" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background-color:#171717;border-radius:10px;">'
        + '<tr><td align="center" valign="top" style="padding:24px;color:#ffffff;">'
        + `<h2 style="margin:0 0 20px;font-size:16px;font-weight:500;color:#86e3ce;letter-spacing:1px;">${escapeHtml(title)}</h2>`
        + headingBlock
        + `<p style="margin:0 0 15px;color:#d8d8d8;line-height:1.6;">${escapeHtml(intro)}</p>`
        + codeBlock
        + noteBlock
        + warningBlock
        + buttonBlock
        + groupBlock
        + footerBlock
        + '</td></tr></table></td></tr></table></body>';
}

/**
 * 渲染纯文本版本，供不支持 HTML 的客户端使用。
 * 与 HTML 版本一致地包含跳转地址、交流群和页脚。
 * @param {{intro: string, note?: string, code?: string, warning?: string, footer?: string, buttonLabel?: string}} options 内容
 * @returns {string} 纯文本
 */
export function renderEmailText(options) {
    const site = getSiteName();
    const {
        intro = '',
        note = '',
        code = '',
        warning = '',
        footer = `本邮件由${site}自动发送，请勿直接回复。`,
        buttonLabel = `进入${site}`,
    } = options;
    const url = getSiteUrl();
    const group = getQqGroup();

    return [
        intro,
        code ? `验证码：${code}` : '',
        note,
        warning,
        url ? `${buttonLabel}：${url}` : '',
        group ? `交流群：${group}` : '',
        footer,
    ].filter(Boolean).join('\n');
}
