const DAY = 86_400_000;

function enumParam(value, options) {
    if (value === undefined) return options[0];
    if (!options.includes(value)) throw new TypeError('无效的筛选或排序选项');
    return value;
}

function positiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
    if (value === undefined) return fallback;
    if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('无效的分页参数');
    return Math.min(value, max);
}

function timestamp(value) {
    return Number.isSafeInteger(value) && value > 0 && value < 8.64e15 ? value : null;
}

/**
 * 管理端分页查询，未记录登录的账号不会计为不活跃。
 * @param {object} body 请求参数
 * @param {number} now 当前毫秒时间
 * @returns {{page:number,pageSize:number,includeAvatars:boolean,match:(user:any,removal:any)=>boolean,compare:(a:any,b:any)=>number}}
 */
export function parseAdminUserQuery(body, now = Date.now()) {
    const { page, pageSize, search, searchBy, handleMatch, loginSeen, loginDays, loginFrom, loginTo, role, enabled, removal, sortBy, sortOrder, includeAvatars } = body;
    if (search !== undefined && (typeof search !== 'string' || search.length > 256)) throw new TypeError('无效的搜索内容');
    const query = (search ?? '').trim().toLowerCase();
    const field = enumParam(searchBy, ['all', 'handle']);
    const matchMode = enumParam(handleMatch, ['contains', 'prefix', 'exact']);
    const seen = enumParam(loginSeen, ['any', 'never', 'recent', 'older', 'range']);
    const days = enumParam(loginDays, [7, 30, 90]);
    const from = timestamp(loginFrom);
    const to = timestamp(loginTo);
    if (seen === 'range' && (from === null || to === null || from >= to)) throw new TypeError('请选择有效的上线时间区间');
    const userRole = enumParam(role, ['all', 'admin', 'user']);
    const enabledStatus = enumParam(enabled, ['all', 'enabled', 'disabled']);
    const removalStatus = enumParam(removal, ['all', 'none', 'pending', 'grace', 'purging']);
    const order = enumParam(sortBy, ['created', 'lastLogin', 'handle']);
    const direction = enumParam(sortOrder, ['asc', 'desc']) === 'asc' ? 1 : -1;
    if (includeAvatars !== undefined && typeof includeAvatars !== 'boolean') throw new TypeError('无效的头像选项');
    const boundary = now - days * DAY;

    return {
        page: positiveInt(page, 1),
        pageSize: positiveInt(pageSize, 25, 100),
        includeAvatars: Boolean(includeAvatars),
        match: (user, job) => {
            const handle = user.handle.toLowerCase();
            const containsQuery = value => String(value ?? '').toLowerCase().includes(query);
            if (query && field === 'all' && ![handle, user.name, user.email].some(containsQuery)) return false;
            if (query && field === 'handle') {
                const matched = matchMode === 'exact' ? handle === query : matchMode === 'prefix' ? handle.startsWith(query) : handle.includes(query);
                if (!matched) return false;
            }
            if (userRole !== 'all' && (userRole === 'admin') !== Boolean(user.admin)) return false;
            if (enabledStatus !== 'all' && (enabledStatus === 'enabled') !== Boolean(user.enabled && job?.state !== 'purging' && !(job?.purgeAt !== null && job?.purgeAt <= now))) return false;
            const state = job?.state ?? 'none';
            if (removalStatus === 'pending' && !['queued', 'sending', 'blocked'].includes(state)) return false;
            if (!['all', 'pending'].includes(removalStatus) && state !== removalStatus) return false;
            const last = timestamp(user.lastLogin);
            switch (seen) {
                case 'never': return last === null;
                case 'recent': return last !== null && last >= boundary;
                case 'older': return last !== null && last < boundary;
                case 'range': return last !== null && last >= from && last < to;
                default: return true;
            }
        },
        compare: (a, b) => {
            const handleOrder = a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0;
            if (order === 'handle') return handleOrder * direction;
            const left = timestamp(a[order]);
            const right = timestamp(b[order]);
            if (left === right) return handleOrder;
            if (left === null) return 1;
            if (right === null) return -1;
            return (left - right) * direction;
        },
    };
}
