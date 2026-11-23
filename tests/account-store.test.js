import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { closeAccountStore, getAllAccounts, getAccount, getAccountStoreState, initAccountStore, recordAccount, removeAccount } from '../src/account-store.js';

let root;
let storageDir;

function fileName(key) {
    return crypto.createHash('sha256').update(key).digest('hex');
}

function writeUser(handle, extra = {}) {
    const key = `user:${handle}`;
    const user = { handle, accountId: crypto.randomUUID(), enabled: true, admin: false, created: Date.now(), ...extra };
    fs.writeFileSync(path.join(storageDir, fileName(key)), JSON.stringify({ key, value: user }));
    return user;
}

beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-account-store-'));
    storageDir = path.join(root, '_storage');
    fs.mkdirSync(storageDir, { recursive: true });
    await initAccountStore({ dataRoot: root });
});

afterEach(() => {
    closeAccountStore();
    fs.rmSync(root, { recursive: true, force: true });
});

test('初始化时加载账号，并按大小写不敏感读取', () => {
    writeUser('alice');
    writeUser('Bob', { admin: true });

    // 目录签名变化后自动重建
    const all = getAllAccounts();

    expect(all.map(user => user.handle).sort()).toEqual(['Bob', 'alice']);
    expect(getAccount('ALICE')?.handle).toBe('alice');
    expect(getAccount('bob')?.admin).toBe(true);
    expect(getAccount('nobody')).toBeNull();
});

test('写入后立即可见，删除后立即消失', () => {
    recordAccount({ handle: 'carol', accountId: crypto.randomUUID(), enabled: true, admin: false });
    expect(getAccount('carol')).not.toBeNull();
    expect(getAccountStoreState().size).toBe(1);

    removeAccount('carol');
    expect(getAccount('carol')).toBeNull();
});

test('外部新增文件会被目录签名检测并加载', () => {
    writeUser('dave');
    expect(getAllAccounts().map(user => user.handle)).toContain('dave');

    writeUser('erin');
    expect(getAllAccounts().map(user => user.handle)).toContain('erin');
});

test('外部原地改写账户文件会被检测并刷新', () => {
    const before = writeUser('frank', { admin: false });
    expect(getAllAccounts().find(user => user.handle === 'frank')?.admin).toBe(false);

    // 覆盖同一个文件，文件数不变，仅 mtime 变化
    const key = 'user:frank';
    fs.writeFileSync(path.join(storageDir, fileName(key)), JSON.stringify({
        key,
        value: { ...before, admin: true },
    }));

    expect(getAllAccounts().find(user => user.handle === 'frank')?.admin).toBe(true);
});

test('SQLite 影子存在时，写入会同步到数据库', async () => {
    const alice = writeUser('alice');
    const { exportAccountsToSqlite } = await import('../src/account-migration.js');
    await exportAccountsToSqlite(root);

    await initAccountStore({ dataRoot: root });
    expect(getAccountStoreState().shadowEnabled).toBe(true);

    recordAccount({ ...alice, admin: true });

    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(root, '_migration-accounts.sqlite'), { readOnly: true });
    const row = db.prepare('SELECT admin, payload FROM accounts WHERE handle = ?').get('alice');
    db.close();

    expect(row.admin).toBe(1);
    expect(JSON.parse(row.payload).admin).toBe(true);
});
