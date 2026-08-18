import { showMessageDialog } from './dialog.js';

export async function showToast(type, message, detailContent) {
    const alertContainer = document.getElementById('alert-container');

    const iconName = {
        info: 'info',
        error: 'circle-x',
        success: 'circle-check',
        warning: 'triangle-alert',
        dialog: 'circle-question-mark',
        modal: 'circle-question-mark'
    };

    const toastType = type === 'modal' ? 'dialog' : type;
    const toastElement = document.createElement('div');
    toastElement.className = 'app-toast animate-fadeInShift';
    toastElement.dataset.status = toastType || 'info';
    toastElement.setAttribute('role', toastType === 'error' || toastType === 'dialog' ? 'alert' : 'status');

    toastElement.innerHTML = `
        <span data-lucide-icon="${iconName[toastType] || iconName.info}" class="app-toast-icon"></span>
        <div class="app-toast-content">
            <span class="text-content"></span>
        </div>
    `;
    toastElement.querySelector('.text-content').textContent = message;

    if (toastType === 'dialog') {
        const learnMoreBtn = document.createElement('button');
        learnMoreBtn.className = 'app-toast-more';
        learnMoreBtn.setAttribute('data-i18n', 'alert.learn_more');
        learnMoreBtn.innerHTML = '<span class="text-content"></span>';
        learnMoreBtn.querySelector('.text-content').innerText = await window.i18n.translate('alert.learn_more');
        learnMoreBtn.addEventListener('click', () => {
            showMessageDialog(message, detailContent);
        });
        toastElement.appendChild(learnMoreBtn);
    } else {
        const closeBtn = document.createElement('button');
        closeBtn.className = 'app-toast-close';
        closeBtn.setAttribute('aria-label', 'Dismiss');
        closeBtn.innerHTML = '<span data-lucide-icon="x"></span>';
        closeBtn.onclick = () => dismissToast(toastElement);
        toastElement.appendChild(closeBtn);
    }

    alertContainer.appendChild(toastElement);

    setTimeout(() => {
        if (toastElement.parentNode) {
            dismissToast(toastElement);
        }
    }, 5000);
}

function dismissToast(toastElement) {
    toastElement.classList.replace('animate-fadeInShift', 'animate-fadeOut');
    setTimeout(() => toastElement.remove(), 300);
}

export const showAlert = showToast;
