import crypto from 'node:crypto';

import storage from 'node-persist';

export const CARDKEY_PREFIX = 'cardkey:';

export function generateCardKey(segments = 4, segmentLength = 4) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const parts = [];

    for (let segment = 0; segment < segments; segment++) {
        let part = '';
        for (let index = 0; index < segmentLength; index++) {
            part += chars.charAt(crypto.randomInt(0, chars.length));
        }
        parts.push(part);
    }

    return parts.join('-');
}

export async function generateCardKeys(count, batchName, creator) {
    const codes = [];

    for (let index = 0; index < count; index++) {
        let code;
        do {
            code = generateCardKey();
        } while (await isCardKeyExists(code));

        const cardKey = {
            code,
            created: Date.now(),
            status: 'unused',
            usedBy: '',
            usedTime: null,
            batchName,
            creator,
        };

        await storage.setItem(`${CARDKEY_PREFIX}${code}`, cardKey);
        codes.push(code);
    }

    return codes;
}

export async function isCardKeyExists(code) {
    return await storage.getItem(`${CARDKEY_PREFIX}${normalizeCardKey(code)}`) !== undefined;
}

export async function verifyCardKey(code) {
    const cardKey = await storage.getItem(`${CARDKEY_PREFIX}${normalizeCardKey(code)}`);
    return !!cardKey && cardKey.status === 'unused';
}

export async function markCardKeyAsUsed(code, usedBy) {
    const normalizedCode = normalizeCardKey(code);
    const cardKey = await storage.getItem(`${CARDKEY_PREFIX}${normalizedCode}`);

    if (!cardKey || cardKey.status !== 'unused') {
        return false;
    }

    cardKey.status = 'used';
    cardKey.usedBy = usedBy;
    cardKey.usedTime = Date.now();

    await storage.setItem(`${CARDKEY_PREFIX}${normalizedCode}`, cardKey);
    return true;
}

export async function getAllCardKeys() {
    const keys = await storage.keys();
    const cardKeys = [];

    for (const key of keys) {
        if (key && typeof key === 'string' && key.startsWith(CARDKEY_PREFIX)) {
            const cardKey = await storage.getItem(key);
            if (cardKey) {
                cardKeys.push(cardKey);
            }
        }
    }

    return cardKeys.sort((a, b) => b.created - a.created);
}

export async function deleteCardKey(code) {
    const normalizedCode = normalizeCardKey(code);
    const cardKey = await storage.getItem(`${CARDKEY_PREFIX}${normalizedCode}`);

    if (!cardKey) {
        return false;
    }

    await storage.removeItem(`${CARDKEY_PREFIX}${normalizedCode}`);
    return true;
}

export async function getCardKeyStats() {
    const cardKeys = await getAllCardKeys();
    const total = cardKeys.length;
    const used = cardKeys.filter(key => key.status === 'used').length;

    return {
        total,
        used,
        unused: total - used,
    };
}

export async function bulkDeleteCardKeys(codes) {
    let success = 0;
    let failed = 0;

    for (const code of codes) {
        if (await deleteCardKey(code)) {
            success++;
        } else {
            failed++;
        }
    }

    return { success, failed };
}

export function normalizeCardKey(code) {
    return String(code ?? '').trim().toUpperCase();
}
