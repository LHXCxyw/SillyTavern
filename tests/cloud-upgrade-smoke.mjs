import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import YAML from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
const host = '127.0.0.1';
const api = '/api/users';
const target = 'cloud-smoke-user';
const untouched = 'cloud-smoke-other';
const expired = 'cloud-smoke-expired';
const expiredEmail = 'expired@example.test';
const password = randomBytes(24).toString('hex');

async function verifySafeSourceTree() {
    // 服务启动包含旧版迁移；不能让它从原工作树移走任何数据。
    for (const name of ['public/characters', 'public/error', 'public/css/user.css', 'access.log']) {
        try {
            await lstat(path.join(root, name));
        } catch (error) {
            if (error.code === 'ENOENT') continue;
            throw error;
        }
        throw new Error(`发现旧版迁移路径 ${name}，请在干净源码工作树运行冒烟测试。`);
    }
}

async function availablePort() {
    const socket = createServer();
    await new Promise((resolve, reject) => socket.once('error', reject).listen(0, host, resolve));
    const { port } = socket.address();
    await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
    return port;
}

function session(baseUrl) {
    const cookies = new Map();
    let csrf;

    async function request(route, { method = 'GET', status = 200, body, headers = {}, withCsrf = true } = {}) {
        const outgoing = new Headers(headers);
        if (cookies.size) outgoing.set('Cookie', [...cookies].map(([key, value]) => `${key}=${value}`).join('; '));
        if (csrf && withCsrf) outgoing.set('x-csrf-token', csrf);
        if (body !== undefined && !(body instanceof FormData)) {
            outgoing.set('Content-Type', 'application/json');
            body = JSON.stringify(body);
        }
        const response = await fetch(`${baseUrl}${route}`, {
            method, headers: outgoing, body,
            redirect: 'error', signal: AbortSignal.timeout(90_000),
        }).catch(error => {
            throw new Error(`${method} ${route} 请求失败`, { cause: error });
        });
        for (const cookie of response.headers.getSetCookie()) {
            const pair = cookie.split(';', 1)[0];
            const equals = pair.indexOf('=');
            const name = pair.slice(0, equals);
            const value = pair.slice(equals + 1);
            if (value) cookies.set(name, value);
            else cookies.delete(name);
        }
        if (response.status !== status) {
            await response.body?.cancel();
            assert.equal(response.status, status, `${method} ${route} HTTP 状态码`);
        }
        return response;
    }

    async function json(route, options) {
        return (await request(route, options)).json();
    }

    async function post(route, body, status = 200) {
        return request(`${api}${route}`, { method: 'POST', body, status });
    }

    async function login(handle, secret = '') {
        csrf = (await json('/csrf-token')).token;
        assert.ok(csrf && csrf !== 'disabled', '测试实例必须启用 CSRF');
        assert.equal((await (await post('/login', { handle, password: secret })).json()).handle, handle);
        csrf = (await json('/csrf-token')).token;
    }

    return { request, json, post, login };
}

async function waitFor(check, timeout, message) {
    const deadline = Date.now() + timeout;
    do {
        const result = await check();
        if (result) return result;
        await delay(150);
    } while (Date.now() < deadline);
    throw new Error(message);
}

async function smoke(baseUrl, dataRoot) {
    const admin = session(baseUrl);
    const user = session(baseUrl);
    const anonymous = session(baseUrl);
    const users = async (query) => (await (await admin.post('/get', query)).json()).items;

    await admin.login('default-user');
    await admin.request(`${api}/create`, { method: 'POST', body: { handle: target, name: target }, status: 403, withCsrf: false });
    for (const handle of [target, untouched]) {
        assert.equal((await (await admin.post('/create', { handle, name: handle, password })).json()).handle, handle);
    }
    const filters = { search: 'cloud-smoke-', searchBy: 'handle', handleMatch: 'prefix', role: 'user', sortBy: 'handle' };
    assert.deepEqual((await users({ ...filters, loginSeen: 'never' })).map(row => row.handle), [untouched, target]);
    await user.login(target, password);
    const [recent] = await users({ ...filters, loginSeen: 'recent', loginDays: 7 });
    assert.equal(recent?.handle, target);
    assert.ok(Number.isSafeInteger(recent.lastLogin));
    assert.deepEqual((await users({ ...filters, loginSeen: 'never' })).map(row => row.handle), [untouched]);
    await user.post('/get', {}, 403);
    assert.equal((await admin.json('/version')).pkgVersion, '1.19.1');
    await (await anonymous.request('/register')).body.cancel();
    const upload = new FormData();
    upload.append('avatar', new Blob(['{"entries":{}}'], { type: 'application/json' }), 'cloud-smoke-world.json');
    assert.equal((await user.json('/api/worldinfo/import', { method: 'POST', body: upload })).name, 'cloud-smoke-world');
    console.log('通过：账户登录、CSRF、上线筛选、管理员权限和实际文件上传。');

    const filename = 'cloud-smoke-marker.txt';
    const marker = '仅用于云升级冒烟测试';
    await writeFile(path.join(dataRoot, target, filename), marker);
    await writeFile(path.join(dataRoot, target, 'secrets.json'), '{"test-only":"not-a-real-secret"}');
    await user.post('/backup/jobs', { handle: untouched }, 403);
    const queued = await (await user.post('/backup/jobs', { handle: target }, 202)).json();
    assert.ok(queued.id);
    assert.ok(['queued', 'running', 'ready'].includes(queued.state), `意外的备份创建状态：${queued.state}`);
    const jobPath = `${api}/backup/jobs/${encodeURIComponent(queued.id)}`;
    const ready = await waitFor(async () => {
        const status = await user.json(jobPath);
        if (status.state === 'ready') return status;
        assert.ok(['queued', 'running'].includes(status.state), `备份未能就绪：${status.state}`);
    }, 30_000, '备份等待就绪超时。');

    const file = `${jobPath}/file`;
    await admin.request(file, { status: 404 });
    await anonymous.request(file, { status: 403 });
    const head = await user.request(file, { method: 'HEAD' });
    const size = Number(head.headers.get('Content-Length'));
    const etag = head.headers.get('ETag');
    assert.equal(size, ready.size);
    assert.ok(size > 32);
    assert.match(etag ?? '', /^"[^"\r\n]+"$/);
    assert.equal(head.headers.get('Accept-Ranges'), 'bytes');
    assert.match(head.headers.get('Content-Disposition') ?? '', /^attachment;.*\.zip/i);
    assert.match(head.headers.get('Cache-Control') ?? '', /\bno-store\b/);

    const first = await user.request(file, { headers: { Range: 'bytes=0-31' }, status: 206 });
    assert.equal(first.headers.get('Content-Range'), `bytes 0-31/${size}`);
    assert.equal(first.headers.get('ETag'), etag);
    const prefix = Buffer.from(await first.arrayBuffer());
    assert.equal(prefix.length, 32);
    const rest = await user.request(file, { headers: { Range: 'bytes=32-', 'If-Range': etag }, status: 206 });
    assert.equal(rest.headers.get('Content-Range'), `bytes 32-${size - 1}/${size}`);
    const zip = Buffer.concat([prefix, Buffer.from(await rest.arrayBuffer())]);
    assert.equal(zip.length, size);
    const entries = unzipSync(zip);
    assert.equal(Buffer.from(entries[filename]).toString('utf8'), marker);
    assert.ok(!Object.hasOwn(entries, 'secrets.json'), '备份不得包含凭据文件');
    const fallback = await user.request(file, { headers: { Range: 'bytes=0-31', 'If-Range': '"stale"' } });
    assert.equal(fallback.headers.get('Content-Range'), null);
    assert.deepEqual(Buffer.from(await fallback.arrayBuffer()), zip);
    const invalid = await user.request(file, { headers: { Range: `bytes=${size}-` }, status: 416 });
    assert.equal(invalid.headers.get('Content-Range'), `bytes */${size}`);
    await invalid.arrayBuffer();
    console.log('通过：备份鉴权、ZIP 内容与凭据排除、HEAD、Range、If-Range 和 416。');

    const mailRoute = '/admin/mail-settings';
    await user.request(`${api}${mailRoute}`, { status: 403 });
    const mail = await admin.json(`${api}${mailRoute}`);
    assert.equal(mail.configured, false);
    assert.equal(mail.passwordConfigured, false);
    assert.ok(!Object.hasOwn(mail.settings, 'pass') && !Object.hasOwn(mail.settings, 'password'));
    assert.equal((await (await admin.post(`${mailRoute}/test`, {}, 409)).json()).code, 'SMTP_TEST_RECIPIENT_NOT_CONFIGURED');

    await admin.post('/delete', { handle: target, purge: true }, 400);
    await user.post('/delete/preview', { handles: [untouched] }, 403);
    const preview = await (await admin.post('/delete/preview', { handles: ['default-user', target] })).json();
    assert.equal(preview.retentionHours, 168);
    assert.equal(preview.items.find(item => item.handle === 'default-user')?.eligible, false);
    assert.equal(preview.items.find(item => item.handle === target)?.eligible, true);
    const submission = { previewId: preview.previewId };
    const confirmed = await (await admin.post('/delete', submission)).json();
    assert.deepEqual(await (await admin.post('/delete', submission)).json(), confirmed);
    assert.equal(confirmed.items.find(item => item.handle === 'default-user')?.ok, false);
    const task = confirmed.items.find(item => item.handle === target);
    assert.ok(task?.ok && task.jobId);
    const jobs = await admin.json(`${api}/delete/jobs`);
    const blocked = jobs.items.find(item => item.id === task.jobId);
    assert.equal(blocked?.state, 'blocked');
    assert.equal(blocked.acceptedAt, null);
    assert.equal(blocked.purgeAt, null);
    await user.request(`${api}/me`);
    assert.equal((await (await admin.post(`/delete/jobs/${task.jobId}/cancel`, {})).json()).state, 'cancelled');
    assert.equal(await readFile(path.join(dataRoot, target, filename), 'utf8'), marker);
    assert.deepEqual((await users(filters)).map(row => row.handle), [untouched, target]);
    console.log('通过：邮件设置隔离、延期清除确认幂等、无通知不计时和任务撤销。');
    await admin.post('/create', { handle: expired, name: expired, email: expiredEmail, password });
    return { file, etag, size, marker, filename, prefix, user, admin };
}

async function seedExpiredRemoval(dataRoot) {
    const key = `user:${expired}`;
    const storagePath = name => path.join(dataRoot, '_storage', createHash('sha256').update(name).digest('hex'));
    const user = JSON.parse(await readFile(storagePath(key), 'utf8')).value;
    const actor = JSON.parse(await readFile(storagePath('user:default-user'), 'utf8')).value;
    const avatarKey = `avatar:${expired}`;
    await writeFile(storagePath(avatarKey), JSON.stringify({ key: avatarKey, value: 'data:image/png;base64,AA==', ttl: false }));
    const uploads = path.join(dataRoot, '_uploads', user.accountId);
    await mkdir(uploads, { recursive: true });
    await writeFile(path.join(uploads, 'test-only'), 'synthetic');
    const id = randomUUID();
    const purgeAt = Date.now() - 1000;
    const acceptedAt = purgeAt - 168 * 3_600_000;
    await writeFile(path.join(dataRoot, '_user-lifecycle', `${id}.json`), JSON.stringify({
        version: 1, id, handle: expired, accountId: user.accountId, actorId: actor.accountId,
        previewId: randomUUID(), email: expiredEmail, state: 'grace', reason: null,
        createdAt: acceptedAt - 1000, updatedAt: acceptedAt, acceptedAt, purgeAt, attempts: 1, sendingAt: null, nextAt: null,
    }));
    return { id, uploads, keyPath: storagePath(key), avatarPath: storagePath(avatarKey) };
}

await verifySafeSourceTree();
const temp = await mkdtemp(path.join(tmpdir(), 'st-cloud-upgrade-'));
const dataRoot = path.join(temp, 'data');
const configPath = path.join(temp, 'config.yaml');
let server;
let closed;
let logs = '';

async function stopServer() {
    if (!server) return;
    const child = server;
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 8_000);
    try {
        await closed;
    } finally {
        clearTimeout(timeout);
        server = undefined;
    }
}

async function startServer() {
    logs = '';
    // 不继承部署配置、邮件密码、代理或 Node 注入参数。
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE)$/i.test(key)));
    server = spawn(process.execPath, ['server.js', '--configPath', configPath, '--dataRoot', dataRoot], {
        cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    closed = new Promise(resolve => server.once('close', resolve));
    let startError;
    server.once('error', error => { startError = error; });
    for (const stream of [server.stdout, server.stderr]) {
        stream.setEncoding('utf8').on('data', chunk => { logs = (logs + chunk).slice(-32_000); });
    }
    await waitFor(() => {
        if (startError) throw startError;
        assert.ok(server.exitCode === null && server.signalCode === null, `服务提前退出：${server.exitCode ?? server.signalCode}`);
        return logs.includes('SillyTavern is listening on');
    }, 120_000, '隔离服务启动超时。');
}

try {
    const port = await availablePort();
    const config = YAML.parse(await readFile(path.join(root, 'default/config.yaml'), 'utf8'));
    Object.assign(config, {
        dataRoot, port, listen: false, listenAddress: { ipv4: host, ipv6: '::1' },
        protocol: { ipv4: true, ipv6: false }, browserLaunch: { enabled: false },
        enableUserAccounts: true, disableCsrfProtection: false, enableServerPlugins: false,
        basicAuthMode: false, allowKeysExposure: false,
        smtp: { host: '', user: '', from: '', testRecipient: '' },
        userLifecycle: { paused: false },
    });
    // 两次完整下载会包含内置素材；只调整回环测试的速率，不改生产限速。
    config.backups.fullData.bytesPerSecond = 8 * 1024 ** 2;
    await writeFile(configPath, YAML.stringify(config));
    await startServer();
    const baseUrl = `http://${host}:${port}`;
    const bundle = await session(baseUrl).request('/lib.js');
    assert.match(await bundle.text(), /\bas createLucideIcon\b/, '前端构建应导出本地 Lucide 图标');
    const sample = await smoke(baseUrl, dataRoot);

    await stopServer();
    const due = await seedExpiredRemoval(dataRoot);
    await startServer();
    const restarted = await sample.user.request(sample.file, { headers: { Range: 'bytes=0-31', 'If-Range': sample.etag }, status: 206 });
    assert.equal(restarted.headers.get('ETag'), sample.etag);
    assert.equal(restarted.headers.get('Content-Range'), `bytes 0-31/${sample.size}`);
    assert.deepEqual(Buffer.from(await restarted.arrayBuffer()), sample.prefix);
    await waitFor(async () => {
        const { items } = await sample.admin.json(`${api}/delete/jobs`);
        return items.find(job => job.id === due.id)?.state === 'cleared';
    }, 15_000, '重启后已过期账号未清除。');
    for (const filename of [path.join(dataRoot, expired), due.uploads, due.keyPath, due.avatarPath]) {
        await assert.rejects(lstat(filename), { code: 'ENOENT' });
    }
    assert.ok((await lstat(path.join(dataRoot, untouched))).isDirectory());
    assert.equal(await readFile(path.join(dataRoot, target, sample.filename), 'utf8'), sample.marker);
    console.log('通过：重启后保持备份续传，已到期账号及头像、暂存上传被清除，其他账户未受影响。');
    console.log('云升级冒烟测试通过。');
} catch (error) {
    console.error(logs);
    throw error;
} finally {
    await stopServer();
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
