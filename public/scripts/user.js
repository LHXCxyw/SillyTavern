import { ArrowDown, ArrowUp, Ban, Camera, Check, Clock, Download, Image, ImageOff, KeyRound, Lock, LockOpen, Mail, Pencil, Search, Settings, Skull, Trash2, TriangleAlert, UserPlus, Users, createLucideIcon } from '../lib.js';
import { getRequestHeaders } from '../script.js';
import { POPUP_RESULT, POPUP_TYPE, callGenericPopup } from './popup.js';
import { canViewSecrets } from './secrets.js';
import { renderTemplateAsync } from './templates.js';
import { ensureImageFormatSupported, getBase64Async, humanFileSize } from './utils.js';

/**
 * @type {import('../../src/users.js').UserViewModel} Logged in user
 */
export let currentUser = null;
export let accountsEnabled = false;

// Extend the session every 10 minutes
const SESSION_EXTEND_INTERVAL = 10 * 60 * 1000;

/**
 * Enable or disable user account controls in the UI.
 * @param {boolean} isEnabled User account controls enabled
 * @returns {Promise<void>}
 */
export async function setUserControls(isEnabled) {
    accountsEnabled = isEnabled;

    if (!isEnabled) {
        $('#logout_button').hide();
        $('#admin_button').hide();
        return;
    }

    $('#logout_button').show();
    await getCurrentUser();
}

/**
 * Check if the current user is an admin.
 * @returns {boolean} True if the current user is an admin
 */
export function isAdmin() {
    if (!accountsEnabled) {
        return true;
    }

    if (!currentUser) {
        return false;
    }

    return Boolean(currentUser.admin);
}

/**
 * Gets the handle string of the current user.
 * @returns {string} User handle
 */
export function getCurrentUserHandle() {
    return currentUser?.handle || 'default-user';
}

/**
 * Get the current user.
 * @returns {Promise<void>}
 */
async function getCurrentUser() {
    try {
        const response = await fetch('/api/users/me', {
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            throw new Error('Failed to get current user');
        }

        currentUser = await response.json();
        $('#admin_button').toggle(accountsEnabled && isAdmin());
        return true;
    } catch (error) {
        console.error('无法读取当前账户：', error);
        return false;
    }
}

/**
 * Enable a user account.
 * @param {string} handle User handle
 * @param {function} callback Success callback
 * @returns {Promise<void>}
 */
async function enableUser(handle, callback) {
    try {
        const response = await fetch('/api/users/enable', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to enable user');
            throw new Error('Failed to enable user');
        }

        callback();
    } catch (error) {
        console.error('Error enabling user:', error);
    }
}

async function disableUser(handle, callback) {
    try {
        const response = await fetch('/api/users/disable', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data?.error || 'Unknown error', 'Failed to disable user');
            throw new Error('Failed to disable user');
        }

        callback();
    } catch (error) {
        console.error('Error disabling user:', error);
    }
}

/**
 * Promote a user to admin.
 * @param {string} handle User handle
 * @param {function} callback Success callback
 * @returns {Promise<void>}
 */
async function promoteUser(handle, callback) {
    try {
        const response = await fetch('/api/users/promote', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to promote user');
            throw new Error('Failed to promote user');
        }

        callback();
    } catch (error) {
        console.error('Error promoting user:', error);
    }
}

/**
 * Demote a user from admin.
 * @param {string} handle User handle
 * @param {function} callback Success callback
 */
async function demoteUser(handle, callback) {
    try {
        const response = await fetch('/api/users/demote', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to demote user');
            throw new Error('Failed to demote user');
        }

        callback();
    } catch (error) {
        console.error('Error demoting user:', error);
    }
}

/**
 * Create a new user.
 * @param {HTMLFormElement} form Form element
 */
async function createUser(form, callback) {
    const errors = [];
    const formData = new FormData(form);

    if (!formData.get('handle')) {
        errors.push('用户名不能为空');
    }

    if (formData.get('password') !== formData.get('confirm')) {
        errors.push('两次输入的密码不一致');
    }

    if (errors.length) {
        toastr.error(errors.join('，'), '创建用户失败');
        return;
    }

    const body = {};
    formData.forEach(function (value, key) {
        if (key === 'confirm') {
            return;
        }
        if (key.startsWith('_')) {
            key = key.substring(1);
        }
        body[key] = value;
    });

    try {
        const response = await fetch('/api/users/create', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || '未知错误', '创建用户失败');
            throw new Error('Failed to create user');
        }

        form.reset();
        callback();
    } catch (error) {
        console.error('Error creating user:', error);
    }
}

/**
 * Shows a popup to change a user's password.
 * @param {string} handle User handle
 * @param {function} callback Success callback
 */
async function changePassword(handle, callback) {
    try {
        const template = $(await renderTemplateAsync('changePassword'));
        template.find('.currentPasswordBlock').toggle(!isAdmin());
        let newPassword = '';
        let confirmPassword = '';
        let oldPassword = '';
        template.find('input[name="current"]').on('input', function () {
            oldPassword = String($(this).val());
        });
        template.find('input[name="password"]').on('input', function () {
            newPassword = String($(this).val());
        });
        template.find('input[name="confirm"]').on('input', function () {
            confirmPassword = String($(this).val());
        });
        const result = await callGenericPopup(template, POPUP_TYPE.CONFIRM, '', { okButton: 'Change', cancelButton: 'Cancel', wide: false, large: false });
        if (result === POPUP_RESULT.CANCELLED || result === POPUP_RESULT.NEGATIVE) {
            throw new Error('Change password cancelled');
        }

        if (newPassword !== confirmPassword) {
            toastr.error('Passwords do not match', 'Failed to change password');
            throw new Error('Passwords do not match');
        }

        const response = await fetch('/api/users/change-password', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle, newPassword, oldPassword }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to change password');
            throw new Error('Failed to change password');
        }

        toastr.success('Password changed successfully', 'Password Changed');
        callback();
    } catch (error) {
        console.error('Error changing password:', error);
    }
}

/**
 * Reset a user's settings.
 * @param {string} handle User handle
 * @param {function} callback Success callback
 */
async function resetSettings(handle, callback) {
    try {
        let password = '';
        const template = $(await renderTemplateAsync('resetSettings'));
        template.find('input[name="password"]').on('input', function () {
            password = String($(this).val());
        });
        const result = await callGenericPopup(template, POPUP_TYPE.CONFIRM, '', { okButton: 'Reset', cancelButton: 'Cancel', wide: false, large: false });

        if (result !== POPUP_RESULT.AFFIRMATIVE) {
            throw new Error('Reset settings cancelled');
        }

        const response = await fetch('/api/users/reset-settings', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle, password }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to reset settings');
            throw new Error('Failed to reset settings');
        }

        toastr.success('Settings reset successfully', 'Settings Reset');
        callback();
    } catch (error) {
        console.error('Error resetting settings:', error);
    }
}

/**
 * Change a user's display name.
 * @param {string} handle User handle
 * @param {string} name Current name
 * @param {function} callback Success callback
 */
async function changeName(handle, name, callback) {
    try {
        const template = $(await renderTemplateAsync('changeName'));
        const result = await callGenericPopup(template, POPUP_TYPE.INPUT, name, { okButton: 'Change', cancelButton: 'Cancel', wide: false, large: false });

        if (!result) {
            throw new Error('Change name cancelled');
        }

        name = String(result);

        const response = await fetch('/api/users/change-name', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle, name }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to change name');
            throw new Error('Failed to change name');
        }

        toastr.success('Name changed successfully', 'Name Changed');
        callback();
    } catch (error) {
        console.error('Error changing name:', error);
    }
}

/**
 * Restore a settings snapshot.
 * @param {string} name Snapshot name
 * @param {function} callback Success callback
 */
async function restoreSnapshot(name, callback) {
    try {
        const confirm = await callGenericPopup(
            `Are you sure you want to restore the settings from "${name}"?`,
            POPUP_TYPE.CONFIRM,
            '',
            { okButton: 'Restore', cancelButton: 'Cancel', wide: false, large: false },
        );

        if (confirm !== POPUP_RESULT.AFFIRMATIVE) {
            throw new Error('Restore snapshot cancelled');
        }

        const response = await fetch('/api/settings/restore-snapshot', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to restore snapshot');
            throw new Error('Failed to restore snapshot');
        }

        callback();
    } catch (error) {
        console.error('Error restoring snapshot:', error);
    }
}

/**
 * Load the content of a settings snapshot.
 * @param {string} name Snapshot name
 * @returns {Promise<string>} Snapshot content
 */
async function loadSnapshotContent(name) {
    try {
        const response = await fetch('/api/settings/load-snapshot', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to load snapshot content');
            throw new Error('Failed to load snapshot content');
        }

        return response.text();
    } catch (error) {
        console.error('Error loading snapshot content:', error);
    }
}

/**
 * Gets a list of settings snapshots.
 * @returns {Promise<Snapshot[]>} List of snapshots
 * @typedef {Object} Snapshot
 * @property {string} name Snapshot name
 * @property {number} date Date in milliseconds
 * @property {number} size File size in bytes
 */
async function getSnapshots() {
    try {
        const response = await fetch('/api/settings/get-snapshots', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to get settings snapshots');
            throw new Error('Failed to get settings snapshots');
        }

        const snapshots = await response.json();
        return snapshots;
    } catch (error) {
        console.error('Error getting settings snapshots:', error);
        return [];
    }
}

/**
 * Make a snapshot of the current settings.
 * @param {function} callback Success callback
 * @returns {Promise<void>}
 */
async function makeSnapshot(callback) {
    try {
        const response = await fetch('/api/settings/make-snapshot', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to make snapshot');
            throw new Error('Failed to make snapshot');
        }

        toastr.success('Snapshot created successfully', 'Snapshot Created');
        callback();
    } catch (error) {
        console.error('Error making snapshot:', error);
    }
}

/**
 * Open the settings snapshots view.
 */
async function viewSettingsSnapshots() {
    const template = $(await renderTemplateAsync('snapshotsView'));
    async function renderSnapshots() {
        const snapshots = await getSnapshots();
        template.find('.snapshotList').empty();

        for (const snapshot of snapshots.sort((a, b) => b.date - a.date)) {
            const snapshotBlock = template.find('.snapshotTemplate .snapshot').clone();
            snapshotBlock.find('.snapshotName').text(snapshot.name);
            snapshotBlock.find('.snapshotDate').text(new Date(snapshot.date).toLocaleString());
            snapshotBlock.find('.snapshotSize').text(humanFileSize(snapshot.size));
            snapshotBlock.find('.snapshotRestoreButton').on('click', async (e) => {
                e.stopPropagation();
                restoreSnapshot(snapshot.name, () => location.reload());
            });
            snapshotBlock.find('.inline-drawer-toggle').on('click', async () => {
                const contentBlock = snapshotBlock.find('.snapshotContent');
                if (!contentBlock.val()) {
                    const content = await loadSnapshotContent(snapshot.name);
                    contentBlock.val(content);
                }
            });
            template.find('.snapshotList').append(snapshotBlock);
        }
    }

    callGenericPopup(template, POPUP_TYPE.TEXT, '', { okButton: 'Close', wide: false, large: false, allowVerticalScrolling: true });
    template.find('.makeSnapshotButton').on('click', () => makeSnapshot(renderSnapshots));
    renderSnapshots();
}

/**
 * Reset everything to default.
 * @param {function} callback Success callback
 */
async function resetEverything(callback) {
    try {
        const step1Response = await fetch('/api/users/reset-step1', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
        });

        if (!step1Response.ok) {
            const data = await step1Response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to reset');
            throw new Error('Failed to reset everything');
        }

        let password = '';
        let code = '';

        const template = $(await renderTemplateAsync('userReset'));
        template.find('input[name="password"]').on('input', function () {
            password = String($(this).val());
        });
        template.find('input[name="code"]').on('input', function () {
            code = String($(this).val());
        });
        const confirm = await callGenericPopup(
            template,
            POPUP_TYPE.CONFIRM,
            '',
            { okButton: 'Reset', cancelButton: 'Cancel', wide: false, large: false },
        );

        if (confirm !== POPUP_RESULT.AFFIRMATIVE) {
            throw new Error('Reset everything cancelled');
        }

        const step2Response = await fetch('/api/users/reset-step2', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ password, code }),
        });

        if (!step2Response.ok) {
            const data = await step2Response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to reset');
            throw new Error('Failed to reset everything');
        }

        toastr.success('Everything reset successfully', 'Reset Everything');
        callback();
    } catch (error) {
        console.error('Error resetting everything:', error);
    }
}

async function openUserProfile() {
    if (!(await getCurrentUser())) {
        toastr.error('无法读取账户资料，请重试。');
        return;
    }
    const template = $(await renderTemplateAsync('userProfile'));
    template.find('.userName').text(currentUser.name);
    template.find('.userHandle').text(currentUser.handle);
    template.find('.avatar img').attr('src', currentUser.avatar);
    template.find('.userRole').text(currentUser.admin ? 'Admin' : 'User');
    template.find('.userCreated').text(new Date(currentUser.created).toLocaleString());
    template.find('.hasPassword').toggle(currentUser.password);
    template.find('.noPassword').toggle(!currentUser.password);
    template.find('.userSettingsSnapshotsButton').on('click', () => viewSettingsSnapshots());
    template.find('.userChangeNameButton').on('click', async () => changeName(currentUser.handle, currentUser.name, async () => {
        await getCurrentUser();
        template.find('.userName').text(currentUser.name);
    }));
    template.find('.userChangePasswordButton').on('click', () => changePassword(currentUser.handle, async () => {
        await getCurrentUser();
        template.find('.hasPassword').toggle(currentUser.password);
        template.find('.noPassword').toggle(!currentUser.password);
    }));
    const removal = currentUser.removal;
    if (removal) {
        const notice = removal.state === 'purging' ? '账户数据正在清除。' : removal.purgeAt
            ? `账户数据保留至 ${accountDate(removal.purgeAt)}（本地时间），请在截止前准备并下载备份。`
            : '账户清除任务待处理，尚无保留期截止时间。';
        template.find('.accountRemovalNotice').prop('hidden', false).find('.accountRemovalText').text(notice);
    }
    renderAccountIcons(template);
    bindBackup(template, currentUser.handle, removal);
    template.find('.userResetSettingsButton').on('click', () => resetSettings(currentUser.handle, () => location.reload()));
    template.find('.userResetAllButton').on('click', () => resetEverything(() => location.reload()));
    template.find('.userAvatarChange').on('click', () => template.find('.avatarUpload').trigger('click'));
    template.find('.avatarUpload').on('change', async function () {
        if (!(this instanceof HTMLInputElement)) {
            return;
        }

        const file = this.files[0];
        if (!file) {
            return;
        }

        await cropAndUploadAvatar(currentUser.handle, file);
        await getCurrentUser();
        template.find('.avatar img').attr('src', currentUser.avatar);
    });
    template.find('.userAvatarRemove').on('click', async function () {
        await changeAvatar(currentUser.handle, '');
        await getCurrentUser();
        template.find('.avatar img').attr('src', currentUser.avatar);
    });

    if (!accountsEnabled) {
        template.find('[data-require-accounts]').hide();
        template.find('.accountsDisabledHint').show();
    }

    const popupOptions = {
        okButton: 'Close',
        wide: false,
        large: false,
        allowVerticalScrolling: true,
        allowHorizontalScrolling: false,
    };
    callGenericPopup(template, POPUP_TYPE.TEXT, '', popupOptions);
}

/**
 * Crop and upload an avatar image.
 * @param {string} handle User handle
 * @param {File} file Avatar file
 * @returns {Promise<string>}
 */
async function cropAndUploadAvatar(handle, file) {
    const dataUrl = await getBase64Async(await ensureImageFormatSupported(file));
    const croppedImage = await callGenericPopup('Set the crop position of the avatar image', POPUP_TYPE.CROP, '', { cropAspect: 1, cropImage: dataUrl });
    if (!croppedImage) {
        return;
    }

    await changeAvatar(handle, String(croppedImage));

    return String(croppedImage);
}

/**
 * Change the avatar of the user.
 * @param {string} handle User handle
 * @param {string} avatar File to upload or base64 string
 * @returns {Promise<void>} Avatar URL
 */
async function changeAvatar(handle, avatar) {
    try {
        const response = await fetch('/api/users/change-avatar', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar, handle }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to change avatar');
            return;
        }
    } catch (error) {
        console.error('Error changing avatar:', error);
    }
}

const accountIcons = { ArrowDown, ArrowUp, Ban, Camera, Check, Clock, Download, Image, ImageOff, KeyRound, Lock, LockOpen, Mail, Pencil, Search, Settings, Skull, Trash2, TriangleAlert, UserPlus, Users };
const removalStates = new Map(Object.entries({ pending: '待处理', queued: '待发送', blocked: '待处理', grace: '保留期', purging: '正在清除', cleared: '已清除', cancelled: '已取消' }));
const backupJobsPath = '/backup/jobs';
const removalJobsPath = '/delete/jobs';
const smtpErrors = new Map(Object.entries({
    SMTP_INVALID_SETTINGS: '邮件配置不合法，请检查连接参数。',
    SMTP_SETTING_LOCKED: '有字段已被部署端锁定，请重新读取设置。',
    SMTP_ENDPOINT_NOT_ALLOWED: '连接参数不符合部署端允许的 SMTP 端点。',
    SMTP_NOT_CONFIGURED: 'SMTP 尚未配置完成。',
    SMTP_TEST_RECIPIENT_NOT_CONFIGURED: '部署端尚未配置测试收件地址。',
    SMTP_TEST_RATE_LIMITED: '测试邮件发送过于频繁，请稍后再试。',
    SMTP_SETTINGS_UNAVAILABLE: '暂时无法读取或保存邮件配置，请稍后再试。',
    SMTP_REJECTED: 'SMTP 服务器拒绝了邮件，请检查连接配置。',
    SMTP_HANDSHAKE_FAILED: '无法连接 SMTP 服务器或完成握手。',
    SMTP_DELIVERY_UNCERTAIN: 'SMTP 未返回明确结果，请先检查收件箱，再决定是否重试。',
    SMTP_INTERNAL_ERROR: '邮件服务发生错误，请查看服务器日志。',
}));

async function previewRemoval(handles, isOpen) {
    const { previewId, expiresAt, retentionHours, items } = await accountRequest('/delete/preview', 'POST', { handles });
    if (!isOpen()) return;
    const eligible = items.filter(item => item.eligible).length;
    const panel = $('<section class="accountPreview">').append(
        $('<h3>').text('清除任务预览'),
        $('<p>').text(`可提交 ${eligible} / ${items.length} 个。保留期为 ${retentionHours} 小时；未能发送通知的任务只会待处理，不会清除数据。`),
        $('<p>').text(`预览有效至 ${accountDate(expiresAt)}。保留期结束后，数据清除不可撤销。`),
    );
    const list = $('<ul class="accountPreviewList" tabindex="0">').appendTo(panel);
    for (const item of items) {
        list.append($('<li>').text(`${item.name || item.handle}（${item.handle}） · ${item.email || '无邮箱'} · ${item.eligible ? '可建立任务' : '不可提交'}${item.reason ? `：${item.reason}` : ''}`));
    }
    const result = await callGenericPopup(panel, eligible ? POPUP_TYPE.CONFIRM : POPUP_TYPE.TEXT, '', {
        okButton: eligible ? '提交清除任务' : '关闭', cancelButton: '返回', allowVerticalScrolling: true,
    });
    if (!eligible || result !== POPUP_RESULT.AFFIRMATIVE || !isOpen()) return;
    if (expiresAt <= Date.now()) throw new Error('预览已过期，请重新预览。');
    const submitted = await accountRequest('/delete', 'POST', { previewId });
    const accepted = submitted.items.filter(item => item.ok).map(item => item.handle);
    const outcome = $('<section class="accountPreview">').append($('<h3>').text(`已提交 ${accepted.length} / ${submitted.items.length} 个任务`));
    const results = $('<ul class="accountPreviewList" tabindex="0">').appendTo(outcome);
    for (const item of submitted.items) {
        results.append($('<li>').text(`${item.handle} · ${item.ok ? removalStates.get(item.state) ?? '已提交' : '未提交'}${item.reason ? `：${item.reason}` : ''}`));
    }
    if (isOpen()) await callGenericPopup(outcome, POPUP_TYPE.TEXT, '', { okButton: '关闭', allowVerticalScrolling: true });
    return accepted;
}

async function changeUserEmail(user, refresh) {
    const label = $('<label>').text('新邮箱');
    const input = $('<input type="email" class="text_pole" autocomplete="off" required autofocus>').val(user.email ?? '').appendTo(label);
    const panel = $('<section class="accountPreview">').append(
        $('<h3>').text(`修改 ${user.handle} 的邮箱`),
        $('<p>').text('更改邮箱会取消已有清除任务。如仍需清除，请使用新邮箱重新预览并排期。'),
        label,
    );
    const result = await callGenericPopup(panel, POPUP_TYPE.CONFIRM, '', { okButton: '保存邮箱', cancelButton: '返回' });
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;
    if (!input[0].checkValidity()) {
        toastr.error('请输入有效的邮箱地址。');
        return;
    }
    const email = String(input.val()).trim();
    if (email === (user.email ?? '')) return;
    try {
        await accountRequest('/admin/change-email', 'POST', { handle: user.handle, email });
        toastr.success('邮箱已更新');
        refresh();
    } catch (error) {
        toastr.error(error.message, '无法修改邮箱', { escapeHtml: true });
    }
}

function bindRemovalJobs(template, refreshUsers) {
    const list = template.find('.jobsList');
    const summary = template.find('.jobsSummary');
    const prev = template.find('.jobsPrev');
    const next = template.find('.jobsNext');
    const pageInfo = template.find('.jobsPageInfo');
    const searchInput = template.find('.jobsSearch');
    const stateInput = template.find('.jobsStateFilter');
    let page = 1;
    let request;
    let closed = false;
    let searchTimer;

    async function refresh(target = page) {
        if (closed) return;
        request?.abort();
        const controller = new AbortController();
        request = controller;
        list.empty().attr('aria-busy', 'true');
        prev.add(next).prop('disabled', true);
        pageInfo.empty();
        summary.text('正在读取清除任务…');
        try {
            const params = new URLSearchParams({ page: String(target) });
            const search = String(searchInput.val() ?? '').trim();
            const state = String(stateInput.val() ?? '');
            if (search) params.set('search', search);
            if (state) params.set('state', state);
            const data = await accountRequest(`${removalJobsPath}?${params}`, 'GET', undefined, controller.signal);
            if (controller.signal.aborted) return;
            const totalPages = Math.max(1, data.totalPages);
            if (target > totalPages && !data.items.length) return refresh(totalPages);
            page = data.page;
            for (const job of data.items) {
                const title = job.name ? `${job.handle}（${job.name}）` : job.handle;
                const row = $('<article class="accountJob" role="listitem">').append(
                    $('<div class="accountsBar">').append($('<strong>').text(title), $('<small>').text(removalStates.get(job.state) ?? job.state)),
                    $('<div class="accountFacts">').text(`邮箱：${job.email || '未提供'} · 创建：${accountDate(job.createdAt)} · 通知受理：${accountDate(job.acceptedAt)} · 清除时间：${accountDate(job.purgeAt)}`),
                );
                if (job.reason) row.append($('<div>').text(job.reason));
                const actions = $('<div class="accountsBar">').appendTo(row);
                const addAction = (label, action, prompt) => {
                    $('<button type="button" class="menu_button">').text(label).appendTo(actions).on('click', async function () {
                        actions.find('button').prop('disabled', true);
                        try {
                            const confirmed = await callGenericPopup($('<p>').text(`${job.handle}：${prompt}`), POPUP_TYPE.CONFIRM, '', { okButton: label, cancelButton: '返回' });
                            if (closed || confirmed !== POPUP_RESULT.AFFIRMATIVE) return;
                            await accountRequest(`${removalJobsPath}/${encodeURIComponent(job.id)}/${action}`, 'POST', {});
                            toastr.success(`${label}成功`);
                            refreshUsers();
                            refresh();
                        } catch (error) {
                            summary.text(`${label}失败：${error.message}`);
                        } finally {
                            actions.find('button').prop('disabled', false);
                        }
                    });
                };
                if (['queued', 'blocked', 'grace'].includes(job.state)) addAction('取消任务', 'cancel', '取消此清除任务？');
                if (job.state === 'blocked') addAction('重试通知', 'retry', '使用任务关联的原邮箱重试？是否可重试由服务器校验。');
                list.append(row);
            }
            list.scrollTop(0);
            summary.text(data.total ? `共 ${data.total} 个任务` : '暂无清除任务');
            pageInfo.text(`第 ${page} / ${totalPages} 页`);
            prev.prop('disabled', page <= 1);
            next.prop('disabled', page >= totalPages);
        } catch (error) {
            if (!controller.signal.aborted) summary.text(`无法读取清除任务：${error.message}`);
        } finally {
            if (controller === request) list.attr('aria-busy', 'false');
        }
    }
    template.find('.jobsRefresh').on('click', () => refresh());
    searchInput.on('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { page = 1; refresh(1); }, 280);
    });
    stateInput.on('change', () => { page = 1; refresh(1); });
    prev.on('click', () => refresh(page - 1));
    next.on('click', () => refresh(page + 1));
    return { refresh, close() { closed = true; request?.abort(); } };
}

function bindMailSettings(template) {
    const form = template.find('.mailSettingsForm');
    const status = form.find('.mailStatus');
    const save = form.find('.mailSave');
    const test = form.find('.mailTest');
    const reload = form.find('.mailRefresh');
    const fieldset = form.find('fieldset');
    const fields = ['host', 'port', 'secure', 'user', 'from', 'testRecipient'];
    const labels = ['SMTP 主机', '端口', '隐式 TLS', 'SMTP 用户名', '发件人', '测试收件地址'];
    let data;
    let busy = false;
    let dirty = false;

    function update(message) {
        const locked = fields.filter(key => data?.locked?.[key]);
        const flags = data ? `SMTP ${data.configured ? '已配置' : '未配置'} · 密码${data.passwordConfigured ? '已配置' : '未配置'} · 测试收件地址${data.testRecipientConfigured ? '已配置' : '未配置'}` : '';
        const lockText = locked.length ? `部署端锁定：${locked.map(key => labels[fields.indexOf(key)]).join('、')}` : '';
        status.text([message, flags, lockText, dirty ? '有未保存的更改' : ''].filter(Boolean).join('。'));
        fieldset.prop('disabled', busy || !data);
        save.prop('disabled', busy || !data || !dirty || locked.length === fields.length);
        test.prop('disabled', busy || dirty || !data?.configured || !data?.testRecipientConfigured);
        reload.prop('disabled', busy);
    }

    async function read() {
        data = await accountRequest(mailSettingsPath);
        for (const key of fields) {
            const field = form.find(`[name="${key}"]`);
            const value = data.settings[key];
            if (key === 'secure') field.prop('checked', Boolean(value));
            else field.val(value ?? '');
            field.prop('disabled', Boolean(data.locked?.[key]));
        }
        dirty = false;
    }

    async function run(progress, operation, success = '') {
        if (busy) return;
        busy = true;
        update(progress);
        let message = success;
        try {
            await operation();
        } catch (error) {
            message = error.message;
        } finally {
            busy = false;
            update(message);
        }
    }

    form.on('input change', 'input', () => { dirty = true; update(); });
    form.on('submit', event => {
        event.preventDefault();
        if (busy || !data || !dirty) return;
        const settings = {};
        for (const key of fields) {
            const field = form.find(`[name="${key}"]`);
            const value = String(field.val() ?? '').trim();
            if (data.locked?.[key]) continue;
            settings[key] = key === 'secure' ? field.prop('checked') : key === 'port' ? Number(value) : value;
        }
        run('正在保存邮件设置…', async () => {
            await accountRequest(mailSettingsPath, 'POST', settings);
            data = null;
            dirty = false;
            await read();
        }, '邮件设置已保存');
    });
    test.on('click', () => run('正在发送测试邮件…', () => accountRequest(`${mailSettingsPath}/test`, 'POST', {}), '测试邮件已提交给 SMTP 服务器'));
    reload.on('click', async () => {
        if (dirty) {
            const result = await callGenericPopup('重新读取将丢弃未保存的更改。', POPUP_TYPE.CONFIRM, '', { okButton: '重新读取', cancelButton: '返回' });
            if (result !== POPUP_RESULT.AFFIRMATIVE) return;
        }
        run('正在读取邮件设置…', read);
    });
    return () => { if (!data) run('正在读取邮件设置…', read); };
}
const mailSettingsPath = '/admin/mail-settings';
const activeBackupJobs = new Map();

function bindBackup(root, handle, removal) {
    const button = root.find('.userBackupButton');
    const status = root.find('.accountBackupStatus');
    const download = $('<a class="menu_button accountDownload" download hidden>').text('下载备份').insertAfter(status);
    const cutoff = removal?.purgeAt;
    const closedForRemoval = () => removal?.state === 'purging' || (Number.isFinite(cutoff) && cutoff <= Date.now());
    const expiryMessage = '账户保留期已结束，无法准备或下载完整备份。';
    let expiryTimer;
    let busy = false;
    let ready;

    function update() {
        const expired = closedForRemoval();
        button.prop('disabled', busy || expired);
        const linkExpired = ready?.expiresAt <= Date.now();
        download.prop('hidden', expired || linkExpired || !ready);
        if (expired || linkExpired) {
            download.removeAttr('href');
            status.text(expired ? expiryMessage : '备份文件已过期，请重新准备。');
        }
    }

    function scheduleExpiry() {
        clearTimeout(expiryTimer);
        const deadline = Math.min(cutoff ?? Infinity, ready?.expiresAt ?? Infinity);
        if (Number.isFinite(deadline) && deadline > Date.now()) {
            expiryTimer = setTimeout(() => {
                if (!root[0]?.isConnected) return;
                update();
                scheduleExpiry();
            }, Math.min(deadline - Date.now(), 2_147_483_647));
        }
    }

    download.on('click', event => {
        update();
        if (download.prop('hidden')) event.preventDefault();
    });
    button.on('click', async () => {
        if (busy || closedForRemoval()) return;
        busy = true;
        ready = undefined;
        download.removeAttr('href');
        status.text('正在请求服务器准备备份…');
        update();
        try {
            let id = activeBackupJobs.get(handle);
            if (!id) {
                const created = await accountRequest(backupJobsPath, 'POST', { handle });
                id = created.id;
                if (!id) throw new Error('服务器未返回备份任务编号。');
                activeBackupJobs.set(handle, id);
                if (await canViewSecrets() === false && root[0]?.isConnected) {
                    toastr.warning('根据服务器配置，备份不包含密钥。');
                }
            }
            const path = `${backupJobsPath}/${encodeURIComponent(id)}`;
            while (root[0]?.isConnected && !closedForRemoval()) {
                let job;
                try {
                    job = await accountRequest(path);
                } catch (error) {
                    if ([401, 403, 404, 410].includes(error.cause)) activeBackupJobs.delete(handle);
                    throw error;
                }
                if (!root[0]?.isConnected || closedForRemoval()) return;
                if (job.state === 'ready') {
                    activeBackupJobs.delete(handle);
                    ready = job;
                    download.attr('href', `/api/users${path}/file`);
                    const size = Number.isFinite(job.size) ? `（${humanFileSize(job.size)}）` : '';
                    const expiry = job.expiresAt ? `有效至 ${accountDate(job.expiresAt)}。` : '';
                    status.text(`备份已就绪${size}。${expiry}请使用当前有权限的登录会话下载。`);
                    scheduleExpiry();
                    return;
                }
                if (!['queued', 'running', 'preparing'].includes(job.state)) {
                    activeBackupJobs.delete(handle);
                    throw new Error(job.error || '服务器未能完成备份，请重试。');
                }
                status.text(job.state === 'queued' ? '服务器排队中…' : '服务器正在打包…');
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
        } catch (error) {
            status.text(`备份失败：${error.message}。可重试；过期文件需重新准备。`);
        } finally {
            busy = false;
            update();
        }
    });
    update();
    scheduleExpiry();
}

function renderAccountIcons(root) {
    root.find('[data-account-icon]').each(function () {
        const icon = accountIcons[this.dataset.accountIcon];
        if (icon) this.replaceChildren(createLucideIcon(icon, { 'aria-hidden': 'true', focusable: 'false' }));
    });
}

function accountDate(value) {
    return Number.isFinite(value) ? new Date(value).toLocaleString() : '无记录';
}

const AVATAR_PLACEHOLDER = 'img/ai4.png';
const avatarObserver = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(entries => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            avatarObserver.unobserve(entry.target);
            const handle = entry.target.dataset.avatarHandle;
            if (handle) entry.target.src = `/api/users/avatar/${encodeURIComponent(handle)}`;
        }
    }, { rootMargin: '80px' })
    : null;

/**
 * 先显示占位图，头像进入可见区域后再单独请求，避免列表响应携带 base64。
 * @param {JQuery} row 账户行
 * @param {string} handle 用户名
 */
function bindLazyAvatar(row, handle) {
    const img = row.find('.avatar img')[0];
    if (!img) return;
    img.src = AVATAR_PLACEHOLDER;
    img.onerror = () => {
        img.onerror = null;
        img.src = AVATAR_PLACEHOLDER;
    };
    if (!avatarObserver) {
        img.src = `/api/users/avatar/${encodeURIComponent(handle)}`;
        return;
    }
    img.dataset.avatarHandle = handle;
    avatarObserver.observe(img);
}

async function accountRequest(path, method = 'GET', body = undefined, signal = undefined) {
    const response = await fetch(`/api/users${path}`, {
        method,
        headers: getRequestHeaders({ omitContentType: body === undefined }),
        body: JSON.stringify(body),
        signal,
    });
    if (!response.ok) {
        const data = await response.json().catch(() => null);
        const message = smtpErrors.get(data?.code) ?? (typeof data?.message === 'string' ? data.message : data?.error);
        const fallback = [401, 403].includes(response.status) ? '会话已失效或权限不足' : `请求失败（HTTP ${response.status}）`;
        throw new Error(typeof message === 'string' ? message : fallback, { cause: response.status });
    }
    return response.status === 204 ? null : response.json().catch(error => {
        if (response.headers.get('Content-Type')?.includes('application/json')) throw error;
        return null;
    });
}

async function openAdminPanel() {
    const template = $(await renderTemplateAsync('admin'));
    if (!template.length) return;
    renderAccountIcons(template);
    const filters = template.find('.usersFilters');
    const list = template.find('.usersListItems');
    const summary = template.find('.usersResultSummary');
    const selection = new Set();
    const limit = 100;
    const pageCheck = template.find('.selectAccountPage');
    const prev = template.find('.usersPrevPage');
    const next = template.find('.usersNextPage');
    const pageInfo = template.find('.usersPageInfo');
    const jobs = bindRemovalJobs(template, () => renderUsers(page));
    const loadMail = bindMailSettings(template);
    let page = 1;
    let filterKey;
    let timer;
    let request;
    let pageHandles = [];
    let selectionNotice = '';
    let previewBusy = false;
    let closed = false;

    function updateSelection() {
        const count = pageHandles.filter(handle => selection.has(handle)).length;
        pageCheck.prop({ checked: count > 0 && count === pageHandles.length, indeterminate: count > 0 && count < pageHandles.length, disabled: !pageHandles.length || previewBusy });
        template.find('.clearSelection, .deleteSelection').prop('disabled', !selection.size || previewBusy);
        template.find('.accountsSelection').text(`${selectionNotice}已选 ${selection.size} / ${limit}，支持跨页`);
        list.find('.accountSelect').each(function () {
            this.checked = selection.has(this.value);
            this.disabled = previewBusy || !pageHandles.includes(this.value);
        });
        list.find('.userDelete').each(function () {
            this.disabled = previewBusy || !pageHandles.includes($(this).closest('.userAccount').find('.accountSelect').val());
        });
    }

    function selectHandles(handles, checked) {
        selectionNotice = '';
        for (const handle of handles) {
            if (!checked) selection.delete(handle);
            else if (selection.size < limit || selection.has(handle)) selection.add(handle);
            else selectionNotice = '已达选择上限。';
        }
        updateSelection();
    }

    async function startPreview(handles) {
        if (!handles.length || previewBusy) return;
        previewBusy = true;
        updateSelection();
        try {
            const accepted = await previewRemoval(handles, () => !closed);
            if (accepted) {
                for (const handle of accepted) selection.delete(handle);
                renderUsers(page);
            }
        } catch (error) {
            toastr.error(error.message, '清除任务提交失败', { escapeHtml: true });
        } finally {
            previewBusy = false;
            updateSelection();
        }
    }

    function renderUser(user) {
        const row = template.find('.userAccountTemplate .userAccount').clone();
        const { handle, removal } = user;
        const refresh = () => renderUsers(page);
        const nameCell = row.find('.userName').text(user.name);
        if (removal) {
            const suffix = removal.state === 'purging' ? '（清除中）' : removal.state === 'grace' ? '（待移除）' : '（待处理）';
            nameCell.append($('<span class="userNameRemoval">').text(suffix));
        }
        row.find('.userHandle').text(handle);
        row.find('.userStatus').text(user.enabled ? '已启用' : '已禁用');
        row.find('.userRole').text(user.admin ? '管理员' : '普通用户');
        row.find('.userPassword').text(user.password ? '有密码' : '无密码');
        row.find('.userEmail').text(user.email || '未填写');
        row.find('.userLastLogin').text(accountDate(user.lastLogin));
        row.find('.userCreated').text(accountDate(user.created));
        row.find('.userRemoval').text(removal ? `${removalStates.get(removal.state) ?? removal.state}${removal.purgeAt ? ` · 截止 ${accountDate(removal.purgeAt)}` : ''}` : user.deletionProtected ? '禁止清除' : '');
        row.find('.avatar img').attr('src', AVATAR_PLACEHOLDER);
        bindLazyAvatar(row, handle);
        row.find('summary').attr('aria-label', `${handle} 的账户操作`);
        row.find('.accountSelect').val(handle).attr('aria-label', `选择用户 ${handle}`).on('change', function () { selectHandles([handle], this.checked); });
        row.find('.userDelete').on('click', () => startPreview([handle]));
        row.find('.userEnableButton').prop('hidden', user.enabled).on('click', () => enableUser(handle, refresh));
        row.find('.userDisableButton').prop('hidden', !user.enabled).on('click', () => disableUser(handle, refresh));
        row.find('.userPromoteButton').prop('hidden', user.admin).on('click', () => promoteUser(handle, refresh));
        row.find('.userDemoteButton').prop('hidden', !user.admin).on('click', () => demoteUser(handle, refresh));
        row.find('.userChangePasswordButton').on('click', () => changePassword(handle, refresh));
        row.find('.userChangeNameButton').on('click', () => changeName(handle, user.name, refresh));
        row.find('.userChangeEmail').on('click', () => changeUserEmail(user, refresh));
        bindBackup(row, handle, removal);
        row.find('.userAvatarChange').on('click', () => row.find('.avatarUpload').trigger('click'));
        row.find('.avatarUpload').on('change', async function () {
            const file = this.files?.[0];
            this.value = '';
            if (!file) return;
            try {
                if (await cropAndUploadAvatar(handle, file)) refresh();
            } catch {
                toastr.error('无法处理该头像文件');
            }
        });
        row.find('.userAvatarRemove').on('click', async () => {
            await changeAvatar(handle, '');
            refresh();
        });
        return row;
    }

    async function renderUsers(targetPage = 1, delay = 0) {
        if (closed) return;
        clearTimeout(timer);
        request?.abort();
        const formData = Object.fromEntries(new FormData(filters[0]));
        const { loginFrom, loginTo, ...values } = formData;
        const range = values.loginSeen === 'range';
        const value = { ...values, search: String(values.search).trim(), loginDays: Number(values.loginDays) };
        const from = range && loginFrom ? new Date(`${loginFrom}T00:00:00`).getTime() : undefined;
        const end = range && loginTo ? new Date(`${loginTo}T00:00:00`) : null;
        const to = end ? end.setDate(end.getDate() + 1) : undefined;
        const query = { ...value, loginFrom: from, loginTo: to };
        const key = JSON.stringify(query);
        if (filterKey !== key) {
            if (selection.size) selectionNotice = '筛选或排序已变更，已清空之前的选择。';
            selection.clear();
            targetPage = 1;
            filterKey = key;
        }
        filters.find('[name="handleMatch"]').parent().prop('hidden', values.searchBy !== 'handle');
        filters.find('[name="loginDays"]').parent().prop('hidden', !['recent', 'older'].includes(String(values.loginSeen)));
        filters.find('[name="loginFrom"], [name="loginTo"]').parent().prop('hidden', !range);
        list.empty().attr('aria-busy', 'true');
        pageHandles = [];
        prev.add(next).prop('disabled', true);
        pageInfo.empty();
        updateSelection();
        if (range && (!Number.isFinite(from) || !Number.isFinite(to) || from >= to)) {
            summary.text('请选择起始和结束日期，起始日期不能晚于结束日期。');
            list.attr('aria-busy', 'false');
            return;
        }
        summary.text('正在读取用户…');
        const controller = new AbortController();
        request = controller;
        if (delay) {
            timer = setTimeout(() => renderUsers(targetPage), delay);
            return;
        }
        try {
            const data = await accountRequest('/get', 'POST', { ...query, page: targetPage, pageSize: 25, includeAvatars: false }, controller.signal);
            if (controller.signal.aborted || closed) return;
            if (targetPage > Math.max(1, data.totalPages) && !data.items.length) {
                renderUsers(Math.max(1, data.totalPages));
                return;
            }
            page = data.page;
            const totalPages = Math.max(1, data.totalPages);
            pageHandles = data.items.filter(user => !user.deletionProtected && user.handle !== currentUser?.handle && !user.removal).map(user => user.handle);
            for (const user of data.items) {
                if (!pageHandles.includes(user.handle)) selection.delete(user.handle);
                list.append(renderUser(user));
            }
            list.scrollTop(0);
            summary.text(data.total ? `共 ${data.total} 个用户` : '没有符合条件的用户');
            pageInfo.text(`第 ${page} / ${totalPages} 页`);
            prev.prop('disabled', page <= 1);
            next.prop('disabled', page >= totalPages);
            updateSelection();
        } catch (error) {
            if (!controller.signal.aborted) summary.text(`无法读取用户：${error.message}。可按“搜索”重试。`);
        } finally {
            if (controller === request) list.attr('aria-busy', 'false');
        }
    }

    pageCheck.on('change', function () { selectHandles(pageHandles, this.checked); });
    template.find('.clearSelection').on('click', () => selectHandles(selection, false));
    template.find('.deleteSelection').on('click', () => startPreview([...selection]));
    prev.on('click', () => renderUsers(page - 1));
    next.on('click', () => renderUsers(page + 1));
    filters.on('submit', event => { event.preventDefault(); renderUsers(); });
    filters.on('reset', () => queueMicrotask(() => renderUsers()));
    filters.on('input', '[name="search"]', () => renderUsers(1, 280));
    filters.on('change', 'select, input[type="date"]', () => renderUsers());
    const nav = template.find('.adminNav button');
    nav.on('click', function () {
        const target = this.dataset.targetTab;
        nav.attr('aria-pressed', 'false');
        $(this).attr('aria-pressed', 'true');
        template.find('.navTab').each(function () { this.hidden = !this.classList.contains(target); });
        if (target === 'removalJobs') jobs.refresh();
        if (target === 'mailSettings') loadMail();
    });

    const handleInput = template.find('.createUserHandle');
    let slugRevision = 0;
    handleInput.on('input', () => { slugRevision++; });
    template.find('.createUserDisplayName').on('input', async function () {
        const revision = ++slugRevision;
        const slug = await slugify(this.value);
        if (revision === slugRevision) handleInput.val(slug);
    });
    template.find('.userCreateForm').on('submit', async function (event) {
        event.preventDefault();
        if (!(this instanceof HTMLFormElement)) return;
        const button = $(this).find('[type="submit"]');
        if (button.prop('disabled')) return;
        button.prop('disabled', true);
        try {
            await createUser(this, () => {
                slugRevision++;
                nav.filter('[data-target-tab="usersList"]').trigger('click').trigger('focus');
                renderUsers();
            });
        } finally {
            button.prop('disabled', false);
        }
    });
    const popup = callGenericPopup(template, POPUP_TYPE.TEXT, '', { okButton: 'Close', wide: true, large: true, allowVerticalScrolling: true, allowHorizontalScrolling: false });
    renderUsers();
    await popup;
    closed = true;
    clearTimeout(timer);
    request?.abort();
    jobs.close();
}

/**
 * Log out the current user.
 * @returns {Promise<void>}
 */
async function logout() {
    await fetch('/api/users/logout', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
    });

    // On an explicit logout stop auto login
    // to allow user to change username even
    // when auto auth (such as authelia or basic)
    // would be valid
    const urlParams = new URLSearchParams(window.location.search);
    urlParams.set('noauto', 'true');

    window.location.search = urlParams.toString();
}

/**
 * Runs a text through the slugify API endpoint.
 * @param {string} text Text to slugify
 * @returns {Promise<string>} Slugified text
 */
async function slugify(text) {
    try {
        const response = await fetch('/api/users/slugify', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ text }),
        });

        if (!response.ok) {
            throw new Error('Failed to slugify text');
        }

        return response.text();
    } catch (error) {
        console.error('Error slugifying text:', error);
        return text;
    }
}

/**
 * Pings the server to extend the user session.
 */
async function extendUserSession() {
    try {
        const response = await fetch('/api/ping?extend=1', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
        });

        if (!response.ok) {
            throw new Error('Ping did not succeed', { cause: response.status });
        }
    } catch (error) {
        console.error('Failed to extend user session', error);
    }
}

jQuery(() => {
    $('#logout_button').on('click', () => {
        logout();
    });
    $('#admin_button').on('click', () => {
        openAdminPanel();
    });
    $('#account_button').on('click', () => {
        openUserProfile();
    });
    setInterval(async () => {
        if (currentUser) {
            await extendUserSession();
        }
    }, SESSION_EXTEND_INTERVAL);
});
