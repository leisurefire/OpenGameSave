import { showMessageDialog } from './dialog.js';

export async function showToast(type, message, detailContent) {
    const alertContainer = document.getElementById('alert-container');

    const toastStyles = {
        info: 'text-white border-white/10',
        error: 'text-red-400 border-red-500/30',
        success: 'text-theme-accent border-theme-accent/30',
        warning: 'text-yellow-400 border-yellow-500/30',
        dialog: 'text-red-400 border-red-500/30',
        modal: 'text-red-400 border-red-500/30',
    };

    const iconClass = {
        info: 'fa-circle-info',
        error: 'fa-circle-xmark',
        success: 'fa-circle-check',
        warning: 'fa-triangle-exclamation',
        dialog: 'fa-circle-question',
        modal: 'fa-circle-question',
    };

    const toastType = type === 'modal' ? 'dialog' : type;
    const toastElement = document.createElement('div');
    toastElement.className = `flex items-center gap-4 p-4 border rounded-lg shadow-2xl bg-[rgb(43,43,43)] ${toastStyles[toastType] || toastStyles.info} animate-fadeInShift max-w-sm`;

    toastElement.innerHTML = `
        <i class="fa-solid ${iconClass[toastType] || iconClass.info} text-xl"></i>
        <div class="flex-1 text-sm font-bold leading-tight">
            <span class="text-content"></span>
        </div>
    `;
    toastElement.querySelector('.text-content').textContent = message;

    if (toastType === 'dialog') {
        const learnMoreBtn = document.createElement('button');
        learnMoreBtn.className = 'text-xs font-black uppercase tracking-widest opacity-60 hover:opacity-100 transition-opacity underline';
        learnMoreBtn.setAttribute('data-i18n', 'alert.learn_more');
        learnMoreBtn.innerHTML = '<span class="text-content"></span>';
        learnMoreBtn.querySelector('.text-content').innerText = await window.i18n.translate('alert.learn_more');
        learnMoreBtn.addEventListener('click', () => {
            showMessageDialog(message, detailContent);
        });
        toastElement.appendChild(learnMoreBtn);
    } else {
        const closeBtn = document.createElement('button');
        closeBtn.className = 'p-1 opacity-40 hover:opacity-100 transition-opacity';
        closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
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
