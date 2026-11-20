let csrfToken = '';
let cardKeyVerified = false;

async function getCsrfToken() {
    const response = await fetch('/csrf-token');
    const data = await response.json();
    return data.token;
}

async function registerUser(userData) {
    console.log('1');
    try {
        console.log('2');
        const response = await fetch('/api/users/register', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken,
            },
            body: JSON.stringify(userData),
        });
        console.log('3');
        if (!response.ok) {
            const errorData = await response.json();
            if (errorData.error === '验证码不正确') {
                throw new Error('验证码不正确，请重新输入');
            } else {
                throw new Error(errorData.error || '注册过程中发生错误');
            }
        }
        console.log('4');
        const data = await response.json();
        console.log('注册成功:', data);

        // 显示用户账号的提示框
        if (data && data.handle) {
            const confirmed = await showHandleConfirmation(data.handle);
            if (confirmed) {
                displaySuccess('注册成功！正在跳转到登录页面...');
                setTimeout(() => {
                    window.location.href = 'login.html';
                }, 2000);
            }
        } else {
            throw new Error('注册成功但未收到用户账号信息');
        }
    } catch (error) {
        console.error('注册错误:', error);
        displayError(error.message);
    }
}

function displayError(message) {
    const errorElement = document.getElementById('errorMessage');
    errorElement.textContent = message;
    errorElement.style.color = 'red';
}

function displaySuccess(message) {
    const errorElement = document.getElementById('errorMessage');
    errorElement.textContent = message;
    errorElement.style.color = 'green';
}

async function sendVerificationCode(email) {
    try {
        // 验证是否为QQ邮箱
        const qqEmailRegex = /^[1-9][0-9]{4,}@qq\.com$/;
        if (!qqEmailRegex.test(email)) {
            throw new Error('请使用QQ邮箱注册');
        }

        const response = await fetch('/api/users/send-verification', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken,
            },
            body: JSON.stringify({ email }),
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || '发送验证码失败');
        }

        displaySuccess('验证码已发送，请查看您的邮箱');
    } catch (error) {
        console.error('发送验证码错误:', error);
        displayError(error.message);
    }
}

// 验证卡密
async function verifyCardKey(code) {
    try {
        if (!code) {
            throw new Error('请输入卡密');
        }

        const response = await fetch('/api/cardkeys-public/verify', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken,
            },
            body: JSON.stringify({ code }),
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || '验证卡密失败');
        }

        const data = await response.json();

        if (data.valid) {
            displaySuccess('卡密有效');
            cardKeyVerified = true;
            return true;
        } else {
            throw new Error('无效的卡密或卡密已被使用');
        }
    } catch (error) {
        console.error('验证卡密错误:', error);
        displayError(error.message);
        cardKeyVerified = false;
        return false;
    }
}

document.addEventListener('DOMContentLoaded', async function () {
    csrfToken = await getCsrfToken();

    const form = document.querySelector('.userCreateForm');
    const sendVerificationButton = document.getElementById('sendVerificationCode');
    const verifyCardKeyButton = document.getElementById('verifyCardKey');
    const handleInput = document.querySelector('.createUserHandle');

    // 添加账号名输入框的事件监听器
    handleInput.addEventListener('input', function () {
        this.value = slugifyHandle(this.value);
    });

    // 发送验证码按钮
    sendVerificationButton.addEventListener('click', function () {
        const email = document.querySelector('.createUserEmail').value;
        if (email) {
            sendVerificationCode(email);
            // 禁用按钮并显示倒计时
            this.disabled = true;
            let countdown = 60;
            const timer = setInterval(() => {
                this.textContent = `重新发送(${countdown}s)`;
                countdown--;
                if (countdown < 0) {
                    clearInterval(timer);
                    this.disabled = false;
                    this.textContent = '发送验证码';
                }
            }, 1000);
        } else {
            displayError('请先输入邮箱地址');
        }
    });

    // 验证卡密按钮
    verifyCardKeyButton.addEventListener('click', function () {
        const cardKey = document.querySelector('.createUserCardKey').value;
        if (cardKey) {
            verifyCardKey(cardKey);
        } else {
            displayError('请先输入卡密');
        }
    });

    form.addEventListener('submit', async function (e) {
        console.log('submit1');
        e.preventDefault();
        const name = document.querySelector('.createUserDisplayName').value;
        const handle = document.querySelector('.createUserHandle').value;
        const password = document.querySelector('.createUserPassword').value;
        const confirmPassword = document.querySelector('.createUserConfirmPassword').value;
        const email = document.querySelector('.createUserEmail').value;
        const verificationCode = document.querySelector('.createUserVerificationCode').value;
        const cardKey = document.querySelector('.createUserCardKey').value;

        console.log('submit2');

        // 验证密码
        if (password !== confirmPassword) {
            return displayError('两次输入的密码不一致');
        }

        // 验证邮箱格式
        const qqEmailRegex = /^[1-9][0-9]{4,}@qq\.com$/;
        if (!qqEmailRegex.test(email)) {
            return displayError('请使用QQ邮箱注册');
        }

        // 验证卡密
        if (!cardKey) {
            return displayError('请输入卡密');
        }

        if (!cardKeyVerified) {
            const isValid = await verifyCardKey(cardKey);
            if (!isValid) {
                return;
            }
        }

        const userData = {
            name,
            handle,
            password,
            email,
            verificationCode,
            cardKey,
        };

        console.log('submit3');
        await registerUser(userData);
    });
});

// 添加新函数用于显示账号确认对话框
function showHandleConfirmation(handle) {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.className = 'custom-modal';
        modal.innerHTML = `
            <div class="modal-content">
                <h2>注册成功</h2>
                <p>您的账号已创建成功！</p>
                <p>您的用户名是: <strong>${handle}</strong></p>
                <p>请记住您的用户名。</p>
                <button id="copyButton">复制用户名</button>
                <button id="confirmButton">确认并继续</button>
            </div>
        `;
        document.body.appendChild(modal);

        const copyButton = modal.querySelector('#copyButton');
        const confirmButton = modal.querySelector('#confirmButton');

        copyButton.addEventListener('click', () => {
            navigator.clipboard.writeText(handle).then(() => {
                copyButton.textContent = '已复制';
                copyButton.disabled = true;
            }).catch(() => {
                copyButton.textContent = '复制失败，请手动复制';
            });
        });

        confirmButton.addEventListener('click', () => {
            document.body.removeChild(modal);
            resolve(true);
        });
    });
}

function slugifyHandle(value) {
    return String(value ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
