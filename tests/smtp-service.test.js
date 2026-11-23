import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';

const createTransport = jest.fn();
const sendMail = jest.fn();
const storage = { getItem: jest.fn(), setItem: jest.fn() };
const getConfigValue = jest.fn();
const requireAdminMiddleware = jest.fn();

jest.unstable_mockModule('nodemailer', () => ({ default: { createTransport } }));
jest.unstable_mockModule('node-persist', () => ({ default: storage }));
jest.unstable_mockModule('../src/util.js', () => ({ getConfigValue }));
jest.unstable_mockModule('../src/users.js', () => ({ requireAdminMiddleware }));

const { getSmtpSettings, saveSmtpSettings, sendAccountRemovalNotice, sendAccountRemovalCancellationNotice, normalizeNotificationAddress } = await import('../src/smtp-service.js');
const { sendVerificationEmail, sendPasswordResetEmail } = await import('../src/emailVerification.js');
const { router } = await import('../src/endpoints/admin-mail.js');
const address = 'user@example.test';
const environment = process.env;
let config;

beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...environment };
    for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_FROM', 'SMTP_PASS', 'SMTP_TEST_RECIPIENT']) {
        delete process.env[key];
    }
    config = {
        'smtp.host': 'smtp.example.test',
        'smtp.user': 'sender@example.test',
        'smtp.pass': 'mock-secret',
        'smtp.testRecipient': 'yaml@example.test',
        'userLifecycle.publicUrl': 'https://example.test/site/',
    };
    getConfigValue.mockImplementation((key, fallback) => config[key] ?? fallback);
    createTransport.mockReturnValue({ sendMail });
    sendMail.mockImplementation(async ({ to }) => ({ accepted: [to], rejected: [] }));
});

afterEach(() => {
    process.env = environment;
});

test('只规范化单一地址并保留本地部分大小写', () => {
    expect(normalizeNotificationAddress(' A.B+tag@Example.TEST ')).toBe('A.B+tag@example.test');
    for (const value of [null, [address], `名称 <${address}>`, `${address},other@example.test`, `${address}\r\n`, 'a..b@example.test']) {
        expect(normalizeNotificationAddress(value)).toBeNull();
    }
});

test('YAML 授权码可用，但不由管理员接口返回或保存', async () => {
    expect(await getSmtpSettings()).toEqual({
        settings: { host: 'smtp.example.test', port: 465, secure: true, user: 'sender@example.test', from: 'sender@example.test', testRecipient: 'yaml@example.test' },
        locked: { host: false, port: false, secure: false, user: false, from: false, testRecipient: false },
        configured: true,
        passwordConfigured: true,
        testRecipientConfigured: true,
    });
    await saveSmtpSettings({ user: 'another@example.test', from: '通知 <another@example.test>' });
    expect(storage.setItem).toHaveBeenCalledWith('smtp_settings', { user: 'another@example.test', from: '通知 <another@example.test>' });
});

test('测试收件地址可在管理面板保存，环境变量存在时锁定', async () => {
    const saved = await saveSmtpSettings({ testRecipient: ' Box@Example.TEST ' });
    expect(storage.setItem).toHaveBeenCalledWith('smtp_settings', { testRecipient: 'Box@example.test' });
    expect(saved).toMatchObject({
        settings: { testRecipient: 'Box@example.test' },
        locked: { testRecipient: false },
        testRecipientConfigured: true,
    });
    await expect(saveSmtpSettings({ testRecipient: 'not-an-address' })).rejects.toMatchObject({ code: 'SMTP_INVALID_SETTINGS' });

    process.env.SMTP_TEST_RECIPIENT = 'env@example.test';
    expect(await getSmtpSettings()).toMatchObject({
        settings: { testRecipient: 'env@example.test' },
        locked: { testRecipient: true },
    });
    await expect(saveSmtpSettings({ testRecipient: 'other@example.test' })).rejects.toMatchObject({ code: 'SMTP_SETTING_LOCKED' });
});

test('非空 SMTP_PASS 优先，空环境变量回退到 YAML 授权码', async () => {
    process.env.SMTP_PASS = 'env-secret';
    await sendAccountRemovalNotice({ email: address });
    expect(createTransport).toHaveBeenLastCalledWith(expect.objectContaining({ auth: { user: 'sender@example.test', pass: 'env-secret' } }));

    process.env.SMTP_PASS = '';
    await sendAccountRemovalNotice({ email: address });
    expect(createTransport).toHaveBeenLastCalledWith(expect.objectContaining({ auth: { user: 'sender@example.test', pass: 'mock-secret' } }));
});

test.each(['', 123456])('没有有效的字符串授权码时不连接 SMTP（%p）', async (pass) => {
    config['smtp.pass'] = pass;
    expect(await getSmtpSettings()).toMatchObject({ configured: false, passwordConfigured: false });
    await expect(sendAccountRemovalNotice({ email: address })).rejects.toMatchObject({ code: 'SMTP_NOT_CONFIGURED', uncertain: false, retryable: false });
    expect(createTransport).not.toHaveBeenCalled();
});

test('检查完整三元组、环境锁定和配置输入', async () => {
    config['smtp.allowedEndpoints'] = [
        { host: 'smtp.example.test', port: 465, secure: true },
        { host: 'relay.example.test', port: 587, secure: false },
    ];
    await expect(saveSmtpSettings({ host: 'relay.example.test', port: 465, secure: true })).rejects.toMatchObject({ code: 'SMTP_ENDPOINT_NOT_ALLOWED' });
    await expect(saveSmtpSettings({ pass: '' })).rejects.toMatchObject({ code: 'SMTP_INVALID_SETTINGS' });
    await expect(saveSmtpSettings({ from: 'sender@example.test\r\n' })).rejects.toMatchObject({ code: 'SMTP_INVALID_SETTINGS' });
    expect(storage.setItem).not.toHaveBeenCalled();
    Object.assign(process.env, { SMTP_HOST: 'relay.example.test', SMTP_PORT: '587', SMTP_SECURE: 'false' });
    expect(await getSmtpSettings()).toMatchObject({
        settings: { host: 'relay.example.test', port: 587, secure: false },
        locked: { host: true, port: true, secure: true },
        configured: true,
    });
    await expect(saveSmtpSettings({ port: 465 })).rejects.toMatchObject({ code: 'SMTP_SETTING_LOCKED' });
    await sendAccountRemovalNotice({ email: address });
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({
        host: 'relay.example.test', port: 587, secure: false, requireTLS: true, tls: { rejectUnauthorized: true },
    }));
});

test('验证码与移除通知共用 SMTP，通知仅包含通用指引及部署链接', async () => {
    await sendVerificationEmail('12345@QQ.COM', '123456');
    await sendPasswordResetEmail('12345@qq.com', '654321');
    await expect(sendAccountRemovalNotice({ email: address })).resolves.toEqual({ acceptedAt: expect.any(Number) });
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({
        secure: true, requireTLS: false, tls: { rejectUnauthorized: true }, auth: { user: 'sender@example.test', pass: 'mock-secret' },
    }));
    expect(sendMail).toHaveBeenNthCalledWith(1, expect.objectContaining({ to: '12345@qq.com', text: expect.stringContaining('123456') }));
    expect(sendMail).toHaveBeenNthCalledWith(2, expect.objectContaining({ to: '12345@qq.com', text: expect.stringContaining('654321') }));
    expect(sendMail.mock.calls[0][0].subject).toBe('【咸鱼傻酒馆】验证码');
    expect(sendMail.mock.calls[1][0].subject).toBe('【咸鱼傻酒馆】密码重置验证码');
    expect(sendMail.mock.calls[2][0].subject).toBe('【咸鱼傻酒馆】账户移除通知');
    expect(sendMail.mock.calls[0][0].text).toContain('进入咸鱼傻酒馆：https://example.test/site/');
    expect(sendMail.mock.calls[0][0].text).toContain('交流群：745442628');
    expect(sendMail.mock.calls[0][0].html).toContain('href="https://example.test/site/"');
    expect(sendMail.mock.calls[0][0].html).toContain('交流群：');
    const text = sendMail.mock.calls[2][0].text;
    expect(text).toMatch(/SMTP.*7 天/);
    expect(text).toContain('确切截止时间');
    expect(text).toContain('下载备份');
    expect(text).toContain('https://example.test/site/');
    expect(text).not.toContain(address);
    expect(text).not.toContain('mock-secret');
    config['userLifecycle.publicUrl'] = 'https://user:secret@example.test/';
    await sendAccountRemovalNotice({ email: address });
    expect(sendMail.mock.calls[3][0].text).not.toContain('https://');
});

test('取消移除通知复用统一模板、站点标题和联系方式', async () => {
    await sendAccountRemovalCancellationNotice({ email: address });
    const mail = sendMail.mock.calls[0][0];
    expect(mail.subject).toBe('【咸鱼傻酒馆】账户移除已取消');
    expect(mail.text).toContain('账号将保持不变');
    expect(mail.text).toContain('进入咸鱼傻酒馆：https://example.test/site/');
    expect(mail.text).toContain('交流群：745442628');
    expect(mail.html).toContain('href="https://example.test/site/"');
});

test('需要目标明确获接收且无拒收；超时和断连保持不确定', async () => {
    for (const result of [{ accepted: ['other@example.test'], rejected: [] }, { accepted: [address], rejected: [address] }, { accepted: [address] }]) {
        sendMail.mockResolvedValueOnce(result);
        await expect(sendAccountRemovalNotice({ email: address })).rejects.toMatchObject({ code: 'SMTP_DELIVERY_UNCERTAIN', uncertain: true, retryable: false });
    }
    for (const code of ['ETIMEDOUT', 'ECONNRESET']) {
        sendMail.mockRejectedValueOnce(Object.assign(new Error('敏感回执'), { code }));
        await expect(sendAccountRemovalNotice({ email: address })).rejects.toMatchObject({ message: 'SMTP_DELIVERY_UNCERTAIN', uncertain: true });
    }
    sendMail.mockRejectedValueOnce(Object.assign(new Error('敏感回执'), { responseCode: 450 }));
    await expect(sendAccountRemovalNotice({ email: address })).rejects.toMatchObject({ code: 'SMTP_REJECTED', uncertain: false, retryable: true });
});

test('管理员路由保护全部入口，测试拒绝自定义收件人和密码，成功返回 204 并限频', async () => {
    const [adminGuard, accountsGuard, ...routes] = router.stack;
    expect(adminGuard.handle).toBe(requireAdminMiddleware);
    expect(routes.map(layer => layer.route.path)).toEqual([
        '/admin/mail-settings', '/admin/mail-settings', '/admin/mail-settings/test',
    ]);
    expect([...routes].every(layer => adminGuard.regexp.test(layer.route.path))).toBe(true);
    const next = jest.fn();
    const forbidden = { sendStatus: jest.fn() };
    accountsGuard.handle({}, forbidden, next);
    expect(forbidden.sendStatus).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    config.enableUserAccounts = true;
    const cache = { set: jest.fn() };
    accountsGuard.handle({}, cache, next);
    expect(cache.set).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(next).toHaveBeenCalledTimes(1);
    const handleTest = routes[2].route.stack[0].handle;
    const response = { status: jest.fn().mockReturnThis(), json: jest.fn(), sendStatus: jest.fn() };
    await handleTest({ body: { to: address }, query: {} }, response);
    await handleTest({ body: { pass: '' }, query: {} }, response);
    expect(response.status).toHaveBeenCalledTimes(2);
    expect(response.status).toHaveBeenLastCalledWith(400);
    expect(createTransport).not.toHaveBeenCalled();
    process.env.SMTP_TEST_RECIPIENT = 'deploy@example.test';
    await handleTest({ body: {}, query: {} }, response);
    expect(response.sendStatus).toHaveBeenCalledWith(204);
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'deploy@example.test' }));
    await handleTest({ body: {}, query: {} }, response);
    expect(response.status).toHaveBeenLastCalledWith(429);
    expect(sendMail).toHaveBeenCalledTimes(1);
});
