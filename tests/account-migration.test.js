import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { isImageDataUrl, removeExportedDatabase, scanLegacyAccounts, storageFileName, exportAccountsToSqlite, verifyExport } from '../src/account-migration.js';

let root;
let storageDir;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-account-scan-'));
    storageDir = path.join(root, '_storage');
    fs.mkdirSync(storageDir, { recursive: true });
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

function writeEntry(key, value) {
    const file = path.join(storageDir, storageFileName(key));
    fs.writeFileSync(file, JSON.stringify({ key, value }));
    return file;
}

test('storageFileName 与 node-persist 一致（SHA-256 十六进制）', () => {
    expect(storageFileName('user:alice')).toBe(crypto.createHash('sha256').update('user:alice').digest('hex'));
});

test('isImageDataUrl 只接受 base64 图片', () => {
    expect(isImageDataUrl('data:image/png;base64,AAAA')).toBe(true);
    expect(isImageDataUrl('data:image/jpeg;base64,AAAA')).toBe(true);
    expect(isImageDataUrl('data:text/plain;base64,AAAA')).toBe(false);
    expect(isImageDataUrl('')).toBe(false);
    expect(isImageDataUrl(null)).toBe(false);
});

test('只读盘点有效账号、头像并忽略无关键', () => {
    const accountId = crypto.randomUUID();
    writeEntry('user:alice', { handle: 'alice', accountId, enabled: true, admin: true, password: 'hash' });
    writeEntry('user:bob', { handle: 'bob', accountId: crypto.randomUUID(), enabled: false });
    writeEntry('avatar:alice', 'data:image/png;base64,AAAA');
    writeEntry('email_code:123@qq.com', { code: '123456' });

    const before = fs.readdirSync(storageDir).sort();
    const report = scanLegacyAccounts(root);
    const after = fs.readdirSync(storageDir).sort();

    expect(after).toEqual(before);
    expect(report.ok).toBe(true);
    expect(report.summary.accountCount).toBe(2);
    expect(report.summary.avatarCount).toBe(1);
    expect(report.accounts.map(item => item.handle)).toEqual(['alice', 'bob']);
    expect(report.accounts.find(item => item.handle === 'alice')).toMatchObject({ admin: true, enabled: true, hasPassword: true });
});

test('缺少或非法 accountId 会阻断迁移', () => {
    writeEntry('user:no-id', { handle: 'no-id' });
    writeEntry('user:bad-id', { handle: 'bad-id', accountId: 'not-a-uuid' });

    const report = scanLegacyAccounts(root);

    expect(report.ok).toBe(false);
    expect(report.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['MISSING_ACCOUNT_ID', 'INVALID_ACCOUNT_ID']));
});

test('大小写不同的同名账号视为冲突', () => {
    writeEntry('user:Alice', { handle: 'Alice', accountId: crypto.randomUUID() });
    writeEntry('user:alice', { handle: 'alice', accountId: crypto.randomUUID() });

    const report = scanLegacyAccounts(root);
    const codes = report.issues.map(issue => issue.code);

    expect(report.ok).toBe(false);
    // 文件名来自 key，大小写不同即两个不同文件；扫描应报告重复但保留两条明细
    expect(report.accounts).toHaveLength(2);
    expect(codes.length === 0 || codes.includes('DUPLICATE_HANDLE')).toBe(true);
});

test('非法头像与损坏文件会被记录', () => {
    writeEntry('avatar:alice', 'not-an-image');
    fs.writeFileSync(path.join(storageDir, 'broken-file'), '{not-json');
    fs.writeFileSync(path.join(storageDir, 'no-key'), JSON.stringify({ value: {} }));

    const report = scanLegacyAccounts(root);
    const codes = report.issues.map(issue => issue.code);

    expect(report.ok).toBe(false);
    expect(codes).toEqual(expect.arrayContaining(['INVALID_AVATAR', 'INVALID_JSON', 'INVALID_ENVELOPE']));
});

test('文件名与 key 哈希不一致会报告', () => {
    fs.writeFileSync(path.join(storageDir, 'wrong-name'), JSON.stringify({
        key: 'user:alice',
        value: { handle: 'alice', accountId: crypto.randomUUID() },
    }));

    const report = scanLegacyAccounts(root);

    expect(report.ok).toBe(false);
    expect(report.issues.map(issue => issue.code)).toContain('HASH_MISMATCH');
});

test('缺少 _storage 时返回阻断结果', () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'st-account-empty-'));
    const report = scanLegacyAccounts(emptyRoot);
    fs.rmSync(emptyRoot, { recursive: true, force: true });

    expect(report.ok).toBe(false);
    expect(report.issues[0].code).toBe('STORAGE_MISSING');
});

test('只读导出 SQLite：KV 不变、数量正确、可回滚', async () => {
    const aliceId = crypto.randomUUID();
    writeEntry('user:alice', { handle: 'alice', accountId: aliceId, enabled: true, admin: true });
    writeEntry('user:bob', { handle: 'bob', accountId: crypto.randomUUID(), enabled: false });
    writeEntry('avatar:alice', 'data:image/png;base64,AAAA');

    const before = fs.readdirSync(storageDir).sort();
    const result = await exportAccountsToSqlite(root);

    expect(result.accountCount).toBe(2);
    expect(result.avatarCount).toBe(1);
    expect(fs.readdirSync(storageDir).sort()).toEqual(before);
    expect(fs.existsSync(result.dbPath)).toBe(true);

    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(result.dbPath, { readOnly: true });
    const rows = db.prepare('SELECT handle, account_id, admin, enabled FROM accounts ORDER BY handle').all();
    db.close();

    expect(rows.map(row => row.handle)).toEqual(['alice', 'bob']);
    expect(rows[0].account_id).toBe(aliceId);
    expect(rows[0].admin).toBe(1);
    expect(rows[1].enabled).toBe(0);

    await expect(exportAccountsToSqlite(root)).rejects.toThrow();
    expect(removeExportedDatabase(root)).toBe(true);
    expect(fs.existsSync(result.dbPath)).toBe(false);
});

test('导出校验能发现导出后的 KV 变更', async () => {
    writeEntry('user:alice', { handle: 'alice', accountId: crypto.randomUUID() });
    await exportAccountsToSqlite(root);

    expect((await verifyExport(root)).ok).toBe(true);

    writeEntry('user:alice', { handle: 'alice', accountId: crypto.randomUUID() });
    const changed = await verifyExport(root);

    expect(changed.ok).toBe(false);
    expect(changed.mismatches.map(item => item.code)).toContain('ACCOUNT_ID_MISMATCH');
});
