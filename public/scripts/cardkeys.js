// 全局变量
let csrfToken = '';
let currentStatus = 'all';
let currentPage = 1;
const PAGE_SIZE = 10;
let cardKeys = [];
let allCardKeys = []; // 存储所有卡密数据
let searchTerm = ''; // 搜索关键词
let filterSettings = { // 筛选设置
    batchName: '',
    createDateStart: '',
    createDateEnd: '',
    useDateStart: '',
    useDateEnd: '',
};
let selectedCardKeys = new Set(); // 存储选中的卡密

// 页面加载完成后执行
document.addEventListener('DOMContentLoaded', async function () {
    // 获取CSRF令牌
    csrfToken = await getCsrfToken();

    // 初始化卡密列表
    await loadCardKeys(currentStatus);

    // 生成卡密按钮点击事件
    document.getElementById('generateButton').addEventListener('click', generateCardKeys);

    // 状态筛选按钮点击事件
    document.querySelectorAll('.filter-button').forEach(button => {
        button.addEventListener('click', function () {
            const status = this.getAttribute('data-status');
            currentStatus = status;
            currentPage = 1;

            // 更新筛选按钮状态
            document.querySelectorAll('.filter-button').forEach(btn => {
                btn.classList.remove('active');
            });
            this.classList.add('active');

            // 重新加载数据
            loadCardKeys(status);
        });
    });

    // 搜索框输入事件
    document.getElementById('searchInput').addEventListener('input', function () {
        searchTerm = this.value.trim().toLowerCase();
        currentPage = 1;
        applySearchAndFilters();
    });

    // 搜索按钮点击事件
    document.getElementById('searchButton').addEventListener('click', function () {
        searchTerm = document.getElementById('searchInput').value.trim().toLowerCase();
        currentPage = 1;
        applySearchAndFilters();
    });

    // 高级筛选面板切换
    document.getElementById('toggleAdvancedFilter').addEventListener('click', function () {
        const panel = document.getElementById('advancedFilterPanel');
        const icon = this.querySelector('i');

        if (panel.classList.contains('active')) {
            panel.classList.remove('active');
            icon.className = 'fa-solid fa-chevron-down';
        } else {
            panel.classList.add('active');
            icon.className = 'fa-solid fa-chevron-up';
        }
    });

    // 应用筛选按钮
    document.getElementById('applyFilterButton').addEventListener('click', function () {
        filterSettings.batchName = document.getElementById('batchFilter').value;
        filterSettings.createDateStart = document.getElementById('createDateStart').value;
        filterSettings.createDateEnd = document.getElementById('createDateEnd').value;
        filterSettings.useDateStart = document.getElementById('useDateStart').value;
        filterSettings.useDateEnd = document.getElementById('useDateEnd').value;

        currentPage = 1;
        applySearchAndFilters();
    });

    // 清除筛选按钮
    document.getElementById('clearFilterButton').addEventListener('click', function () {
        // 清除搜索框
        document.getElementById('searchInput').value = '';
        searchTerm = '';

        // 清除高级筛选设置
        document.getElementById('batchFilter').value = '';
        document.getElementById('createDateStart').value = '';
        document.getElementById('createDateEnd').value = '';
        document.getElementById('useDateStart').value = '';
        document.getElementById('useDateEnd').value = '';

        // 重置筛选设置对象
        filterSettings = {
            batchName: '',
            createDateStart: '',
            createDateEnd: '',
            useDateStart: '',
            useDateEnd: '',
        };

        // 重新应用筛选
        currentPage = 1;
        applySearchAndFilters();
    });

    // 全选复选框事件
    document.getElementById('selectAllCheckbox').addEventListener('change', function () {
        const checkboxes = document.querySelectorAll('#cardKeyTableBody input[type="checkbox"]');
        checkboxes.forEach(checkbox => {
            checkbox.checked = this.checked;
            const cardKeyCode = checkbox.getAttribute('data-code');
            if (this.checked) {
                selectedCardKeys.add(cardKeyCode);
            } else {
                selectedCardKeys.delete(cardKeyCode);
            }
        });
        updateSelectedCount();
    });

    // 选择当前页所有卡密
    document.getElementById('selectAllCurrentButton').addEventListener('click', function () {
        const checkboxes = document.querySelectorAll('#cardKeyTableBody input[type="checkbox"]');
        checkboxes.forEach(checkbox => {
            checkbox.checked = true;
            const cardKeyCode = checkbox.getAttribute('data-code');
            selectedCardKeys.add(cardKeyCode);
        });
        document.getElementById('selectAllCheckbox').checked = true;
        updateSelectedCount();
    });

    // 选择所有筛选结果
    document.getElementById('selectAllFilteredButton').addEventListener('click', function () {
        // 先清空之前的选择
        selectedCardKeys.clear();

        // 将所有筛选后的卡密添加到选中集合
        cardKeys.forEach(cardKey => {
            selectedCardKeys.add(cardKey.code);
        });

        // 更新当前页面上的复选框
        const checkboxes = document.querySelectorAll('#cardKeyTableBody input[type="checkbox"]');
        checkboxes.forEach(checkbox => {
            checkbox.checked = true;
        });

        document.getElementById('selectAllCheckbox').checked = true;
        updateSelectedCount();
    });

    // 取消所有选择
    document.getElementById('deselectAllButton').addEventListener('click', function () {
        selectedCardKeys.clear();
        document.getElementById('selectAllCheckbox').checked = false;
        const checkboxes = document.querySelectorAll('#cardKeyTableBody input[type="checkbox"]');
        checkboxes.forEach(checkbox => {
            checkbox.checked = false;
        });
        updateSelectedCount();
    });

    // 批量删除按钮点击事件
    document.getElementById('bulkDeleteButton').addEventListener('click', async function () {
        if (selectedCardKeys.size === 0) {
            showError('请至少选择一个卡密进行删除');
            return;
        }

        if (!confirm(`确定要删除选中的 ${selectedCardKeys.size} 个卡密吗？`)) {
            return;
        }

        try {
            showLoading(true);
            const codesToDelete = Array.from(selectedCardKeys);
            console.log('准备发送批量删除请求，卡密数量:', codesToDelete.length);
            const response = await fetch('/api/cardkeys/bulk_delete', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrfToken,
                },
                body: JSON.stringify({
                    codes: codesToDelete,
                }),
            });

            // 如果响应状态不是200，尝试读取响应体文本而不是JSON
            if (!response.ok) {
                const responseText = await response.text();
                console.error('批量删除API错误响应:', response.status, responseText);
                throw new Error(`API错误: ${response.status} - ${responseText.substring(0, 100)}`);
            }

            const data = await response.json();
            showSuccess(`成功删除 ${data.success} 个卡密${data.failed > 0 ? `，${data.failed} 个卡密删除失败` : ''}`);

            // 清空选中的卡密
            selectedCardKeys.clear();

            // 重新加载卡密列表
            await loadCardKeys(currentStatus);
        } catch (error) {
            console.error('批量删除卡密失败:', error);
            showError('批量删除卡密失败: ' + error.message);
        } finally {
            showLoading(false);
        }
    });

    // 关闭弹窗按钮点击事件
    document.getElementById('closeModal').addEventListener('click', function () {
        document.getElementById('generatedModal').style.display = 'none';
    });

    // 复制全部卡密按钮点击事件
    document.getElementById('copyAllButton').addEventListener('click', function () {
        const cardKeysText = Array.from(document.querySelectorAll('#generatedCardKeys code'))
            .map(code => code.textContent)
            .join('\n');

        navigator.clipboard.writeText(cardKeysText)
            .then(() => {
                this.textContent = '已复制';
                setTimeout(() => {
                    this.textContent = '复制全部卡密';
                }, 2000);
            })
            .catch(err => {
                console.error('复制失败:', err);
                this.textContent = '复制失败';
                setTimeout(() => {
                    this.textContent = '复制全部卡密';
                }, 2000);
            });
    });

    // 点击弹窗背景关闭弹窗
    window.addEventListener('click', function (event) {
        const modal = document.getElementById('generatedModal');
        if (event.target === modal) {
            modal.style.display = 'none';
        }
    });
});

// 获取CSRF令牌
async function getCsrfToken() {
    const response = await fetch('/csrf-token');
    const data = await response.json();
    return data.token;
}

// 加载卡密列表
async function loadCardKeys(status = 'all') {
    try {
        showLoading(true);
        showEmptyMessage(false);

        const response = await fetch(`/api/cardkeys/list?status=${status}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken,
            },
        });

        if (!response.ok) {
            throw new Error('加载卡密列表失败');
        }

        const data = await response.json();
        allCardKeys = data.cardKeys || []; // 更新所有卡密数据

        // 更新批次筛选下拉框
        updateBatchFilter();

        // 应用筛选和搜索
        applySearchAndFilters();

        // 更新统计信息
        updateStats(data.stats);

        // 如果没有数据，显示空消息
        if (cardKeys.length === 0) {
            showEmptyMessage(true);
        }
    } catch (error) {
        console.error('加载卡密列表失败:', error);
        showError('加载卡密列表失败: ' + error.message);
    } finally {
        showLoading(false);
    }
}

// 生成卡密
async function generateCardKeys() {
    try {
        const batchName = document.getElementById('batchName').value.trim();
        const count = parseInt(document.getElementById('count').value);

        if (!batchName) {
            return showError('请输入批次名称');
        }

        if (isNaN(count) || count < 1 || count > 100) {
            return showError('生成数量必须在1-100之间');
        }

        showLoading(true);

        const response = await fetch('/api/cardkeys/create', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken,
            },
            body: JSON.stringify({
                batchName,
                count,
            }),
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || '生成卡密失败');
        }

        const data = await response.json();

        // 显示生成的卡密
        showGeneratedCardKeys(data.codes);

        // 重新加载卡密列表
        await loadCardKeys(currentStatus);

        showSuccess(`成功生成 ${count} 个卡密`);
    } catch (error) {
        console.error('生成卡密失败:', error);
        showError('生成卡密失败: ' + error.message);
    } finally {
        showLoading(false);
    }
}

// 删除卡密
async function deleteCardKey(code) {
    if (!confirm(`确定要删除卡密 ${code} 吗？`)) {
        return;
    }

    try {
        showLoading(true);

        const response = await fetch(`/api/cardkeys/delete/${code}`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken,
            },
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || '删除卡密失败');
        }

        const data = await response.json();

        if (data.success) {
            showSuccess(`卡密 ${code} 已成功删除`);
            await loadCardKeys(currentStatus);
        } else {
            showError('删除卡密失败');
        }
    } catch (error) {
        console.error('删除卡密失败:', error);
        showError('删除卡密失败: ' + error.message);
    } finally {
        showLoading(false);
    }
}

// 更新统计信息
function updateStats(stats) {
    document.getElementById('totalCount').textContent = stats.total || 0;
    document.getElementById('usedCount').textContent = stats.used || 0;
    document.getElementById('unusedCount').textContent = stats.unused || 0;
}

// 渲染卡密表格
function renderCardKeysTable() {
    const tableBody = document.getElementById('cardKeyTableBody');
    tableBody.innerHTML = '';

    // 计算当前页的数据
    const startIndex = (currentPage - 1) * PAGE_SIZE;
    const endIndex = Math.min(startIndex + PAGE_SIZE, cardKeys.length);
    const pageData = cardKeys.slice(startIndex, endIndex);

    pageData.forEach(cardKey => {
        const row = document.createElement('tr');

        // 复选框单元格
        const checkboxCell = document.createElement('td');
        checkboxCell.className = 'check-column';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.setAttribute('data-code', cardKey.code);
        checkbox.checked = selectedCardKeys.has(cardKey.code);
        checkbox.addEventListener('change', function () {
            if (this.checked) {
                selectedCardKeys.add(cardKey.code);
            } else {
                selectedCardKeys.delete(cardKey.code);
            }
            updateSelectedCount();
        });
        checkboxCell.appendChild(checkbox);
        row.appendChild(checkboxCell);

        // 卡密
        const codeCell = document.createElement('td');
        codeCell.textContent = cardKey.code;

        // 添加复制按钮
        const copyButton = document.createElement('button');
        copyButton.className = 'copy-button';
        copyButton.innerHTML = '<i class="fa-solid fa-copy"></i>';
        copyButton.title = '复制卡密';
        copyButton.addEventListener('click', function () {
            navigator.clipboard.writeText(cardKey.code)
                .then(() => {
                    this.classList.add('copied');
                    setTimeout(() => {
                        this.classList.remove('copied');
                    }, 2000);
                })
                .catch(err => console.error('复制失败:', err));
        });
        codeCell.appendChild(copyButton);
        row.appendChild(codeCell);

        // 批次名称
        const batchCell = document.createElement('td');
        batchCell.textContent = cardKey.batchName;
        row.appendChild(batchCell);

        // 创建时间
        const createdCell = document.createElement('td');
        createdCell.textContent = formatDate(cardKey.created);
        row.appendChild(createdCell);

        // 状态
        const statusCell = document.createElement('td');
        statusCell.textContent = cardKey.status === 'unused' ? '未使用' : '已使用';
        statusCell.className = cardKey.status === 'unused' ? 'status-unused' : 'status-used';
        row.appendChild(statusCell);

        // 使用者
        const userCell = document.createElement('td');
        userCell.textContent = cardKey.usedBy || '-';
        row.appendChild(userCell);

        // 使用时间
        const usedTimeCell = document.createElement('td');
        usedTimeCell.textContent = cardKey.usedTime ? formatDate(cardKey.usedTime) : '-';
        row.appendChild(usedTimeCell);

        // 操作
        const actionCell = document.createElement('td');
        const deleteButton = document.createElement('button');
        deleteButton.className = 'action-button';
        deleteButton.innerHTML = '<i class="fa-solid fa-trash"></i>';
        deleteButton.title = '删除卡密';
        deleteButton.addEventListener('click', () => deleteCardKey(cardKey.code));
        actionCell.appendChild(deleteButton);
        row.appendChild(actionCell);

        tableBody.appendChild(row);
    });

    // 更新全选复选框状态
    updateSelectAllCheckboxState();
}

// 更新选中数量
function updateSelectedCount() {
    const count = selectedCardKeys.size;
    document.getElementById('selectedCount').textContent = count;

    // 更新批量删除按钮状态
    const bulkDeleteButton = document.getElementById('bulkDeleteButton');
    bulkDeleteButton.disabled = count === 0;

    // 更新取消选择按钮状态
    const deselectAllButton = document.getElementById('deselectAllButton');
    deselectAllButton.disabled = count === 0;
}

// 更新全选复选框状态
function updateSelectAllCheckboxState() {
    const selectAllCheckbox = document.getElementById('selectAllCheckbox');
    const checkboxes = document.querySelectorAll('#cardKeyTableBody input[type="checkbox"]');

    if (checkboxes.length === 0) {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.disabled = true;
        return;
    }

    selectAllCheckbox.disabled = false;

    const allChecked = Array.from(checkboxes).every(checkbox => checkbox.checked);
    const someChecked = Array.from(checkboxes).some(checkbox => checkbox.checked);

    if (allChecked) {
        selectAllCheckbox.checked = true;
        selectAllCheckbox.indeterminate = false;
    } else if (someChecked) {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = true;
    } else {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = false;
    }
}

// 渲染分页控件
function renderPagination() {
    const pagination = document.getElementById('pagination');
    pagination.innerHTML = '';

    const totalPages = Math.ceil(cardKeys.length / PAGE_SIZE);

    if (totalPages <= 1) {
        pagination.style.display = 'none';
        return;
    }

    pagination.style.display = 'flex';

    // 上一页按钮
    const prevButton = document.createElement('button');
    prevButton.textContent = '上一页';
    prevButton.disabled = currentPage === 1;
    prevButton.addEventListener('click', () => {
        if (currentPage > 1) {
            currentPage--;
            renderCardKeysTable();
            renderPagination();
        }
    });
    pagination.appendChild(prevButton);

    // 页码按钮
    const maxButtons = 5;
    let startPage = Math.max(1, currentPage - Math.floor(maxButtons / 2));
    let endPage = Math.min(totalPages, startPage + maxButtons - 1);

    if (endPage - startPage + 1 < maxButtons) {
        startPage = Math.max(1, endPage - maxButtons + 1);
    }

    for (let i = startPage; i <= endPage; i++) {
        const pageButton = document.createElement('button');
        pageButton.textContent = i;
        pageButton.className = i === currentPage ? 'active' : '';
        pageButton.addEventListener('click', () => {
            currentPage = i;
            renderCardKeysTable();
            renderPagination();
        });
        pagination.appendChild(pageButton);
    }

    // 下一页按钮
    const nextButton = document.createElement('button');
    nextButton.textContent = '下一页';
    nextButton.disabled = currentPage === totalPages;
    nextButton.addEventListener('click', () => {
        if (currentPage < totalPages) {
            currentPage++;
            renderCardKeysTable();
            renderPagination();
        }
    });
    pagination.appendChild(nextButton);
}

// 显示生成的卡密弹窗
function showGeneratedCardKeys(codes) {
    const container = document.getElementById('generatedCardKeys');
    container.innerHTML = '';

    codes.forEach(code => {
        const codeElement = document.createElement('code');
        codeElement.textContent = code;
        container.appendChild(codeElement);
    });

    document.getElementById('generatedModal').style.display = 'flex';
}

// 显示加载中
function showLoading(show) {
    document.getElementById('loadingMessage').className = show ? 'loading' : 'loading hidden';
}

// 显示空消息
function showEmptyMessage(show) {
    document.getElementById('emptyMessage').className = show ? 'empty-message' : 'empty-message hidden';
}

// 显示错误消息
function showError(message) {
    const errorElement = document.getElementById('errorMessage');
    errorElement.textContent = message;
    errorElement.className = 'error-message';

    setTimeout(() => {
        errorElement.className = 'error-message hidden';
    }, 5000);
}

// 显示成功消息
function showSuccess(message) {
    const successElement = document.getElementById('successMessage');
    successElement.textContent = message;
    successElement.className = 'success-message';

    setTimeout(() => {
        successElement.className = 'success-message hidden';
    }, 5000);
}

// 格式化日期
function formatDate(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
}

// 提取日期部分（不含时间）
function extractDateOnly(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString);
    return date.toISOString().split('T')[0]; // 返回YYYY-MM-DD格式
}

// 应用搜索和筛选条件
function applySearchAndFilters() {
    if (allCardKeys.length === 0) {
        cardKeys = [];
        renderCardKeysTable();
        renderPagination();
        updateSelectedCount();
        return;
    }

    // 从所有卡密中筛选符合条件的卡密
    cardKeys = allCardKeys.filter(cardKey => {
        // 按状态筛选（全部/已使用/未使用）
        if (currentStatus !== 'all' && cardKey.status !== currentStatus) {
            return false;
        }

        // 搜索功能（卡密号或使用者）
        if (searchTerm) {
            const codeMatch = cardKey.code.toLowerCase().includes(searchTerm);
            const userMatch = cardKey.usedBy && cardKey.usedBy.toLowerCase().includes(searchTerm);
            if (!codeMatch && !userMatch) {
                return false;
            }
        }

        // 批次筛选
        if (filterSettings.batchName && cardKey.batchName !== filterSettings.batchName) {
            return false;
        }

        // 创建时间范围筛选
        if (filterSettings.createDateStart) {
            const createDate = extractDateOnly(cardKey.created);
            if (createDate < filterSettings.createDateStart) {
                return false;
            }
        }

        if (filterSettings.createDateEnd) {
            const createDate = extractDateOnly(cardKey.created);
            if (createDate > filterSettings.createDateEnd) {
                return false;
            }
        }

        // 使用时间范围筛选
        if (filterSettings.useDateStart && cardKey.usedTime) {
            const useDate = extractDateOnly(cardKey.usedTime);
            if (useDate < filterSettings.useDateStart) {
                return false;
            }
        }

        if (filterSettings.useDateEnd && cardKey.usedTime) {
            const useDate = extractDateOnly(cardKey.usedTime);
            if (useDate > filterSettings.useDateEnd) {
                return false;
            }
        }

        // 通过所有筛选条件
        return true;
    });

    // 更新表格和分页
    currentPage = 1; // 重置到第一页
    renderCardKeysTable();
    renderPagination();
    updateSelectedCount();

    // 显示或隐藏空消息
    if (cardKeys.length === 0) {
        showEmptyMessage(true);
    } else {
        showEmptyMessage(false);
    }
}

// 更新批次筛选下拉框
function updateBatchFilter() {
    const batchSelect = document.getElementById('batchFilter');

    // 清除当前选项（保留默认选项）
    while (batchSelect.options.length > 1) {
        batchSelect.remove(1);
    }

    // 提取所有不重复的批次名称
    const batches = [...new Set(allCardKeys.map(key => key.batchName))].sort();

    // 添加批次选项
    batches.forEach(batch => {
        const option = document.createElement('option');
        option.value = batch;
        option.textContent = batch;
        batchSelect.appendChild(option);
    });

    // 如果有之前选择的批次，尝试恢复选择
    if (filterSettings.batchName) {
        const exists = Array.from(batchSelect.options).some(option => option.value === filterSettings.batchName);
        if (exists) {
            batchSelect.value = filterSettings.batchName;
        } else {
            filterSettings.batchName = ''; // 如果不存在了，重置筛选值
        }
    }
}
