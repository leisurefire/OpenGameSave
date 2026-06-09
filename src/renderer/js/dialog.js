function resetDialogElement(titleElement, contentElement, actionButtons) {
    titleElement.removeAttribute('data-i18n');
    titleElement.className = 'text-xl font-bold text-xbox-green';
    titleElement.textContent = '';

    contentElement.className = 'text-white/80 leading-relaxed';
    contentElement.innerHTML = '';

    actionButtons.forEach(button => {
        button.onclick = null;
        button.removeAttribute('data-i18n');
        button.className = button.id === 'modal-info-confirm'
            ? 'primary-button px-8 py-2'
            : 'px-6 py-2 rounded-lg bg-white/10 hover:bg-white/20 transition-colors';
        button.style.display = 'none';
        button.textContent = '';
    });
}

function renderDialogContent(contentElement, content) {
    if (typeof content === 'function') {
        content(contentElement);
    } else if (Array.isArray(content)) {
        contentElement.innerHTML = content.map(item => {
            if (Array.isArray(item)) {
                return `<ul class="space-y-2 py-2">${item.map(li => `<li class="flex gap-2 opacity-80 text-sm"><i class="fa-solid fa-caret-right text-xbox-green mt-1"></i>${li}</li>`).join('')}</ul>`;
            }
            return `<p class="text-sm opacity-80 leading-relaxed mb-2">${item}</p>`;
        }).join('');
    } else {
        contentElement.textContent = content;
        contentElement.className = 'text-sm opacity-80 leading-relaxed';
    }
}

function hasActiveModal(dialog) {
    return Array.from(document.querySelectorAll('[id^="modal-"]')).some(modal => {
        return modal !== dialog && !modal.classList.contains('hidden') && modal.classList.contains('flex');
    });
}

async function resolveButtonText(button) {
    if (button.text) return button.text;
    if (button.i18n) return await window.i18n.translate(button.i18n);
    return '';
}

export async function showDialog({
    title,
    content,
    buttons = [{ value: true, i18n: 'alert.confirm', primary: true }],
    closeValue = true,
    beforeOpen,
    afterClose
}) {
    return new Promise(async (resolve) => {
        let isResolved = false;
        const dialog = document.getElementById('modal-info');
        const overlay = document.getElementById('modal-overlay');
        const titleElement = document.getElementById('modal-info-title');
        const contentElement = document.getElementById('modal-info-content');
        const closeButton = document.getElementById('modal-info-close');
        const secondaryButton = document.getElementById('modal-info-no');
        const primaryButton = document.getElementById('modal-info-confirm');
        const actionButtons = [secondaryButton, primaryButton];
        const originalDialogZIndex = dialog.style.zIndex;
        const originalOverlayZIndex = overlay.style.zIndex;
        const wasOverlayVisible = !overlay.classList.contains('hidden');

        resetDialogElement(titleElement, contentElement, actionButtons);
        titleElement.textContent = title;
        renderDialogContent(contentElement, content);
        if (beforeOpen) beforeOpen({ dialog, overlay, titleElement, contentElement, closeButton, secondaryButton, primaryButton });

        const cleanupListeners = () => {
            closeButton.onclick = null;
            actionButtons.forEach(button => {
                button.onclick = null;
                button.removeAttribute('data-i18n');
            });
        };

        const closeDialog = () => {
            dialog.classList.add('hidden');
            dialog.classList.remove('flex');
            dialog.style.zIndex = originalDialogZIndex;
            overlay.style.zIndex = originalOverlayZIndex;
            overlay.classList.toggle('hidden', !(wasOverlayVisible && hasActiveModal(dialog)));
            cleanupListeners();
        };

        const finish = (value) => {
            if (isResolved) return;
            isResolved = true;
            closeDialog();
            if (afterClose) afterClose(value);
            resolve(value);
        };

        actionButtons.forEach(button => {
            button.style.display = 'none';
            button.textContent = '';
        });

        const visibleButtons = buttons.slice(-2);
        for (let index = 0; index < visibleButtons.length; index += 1) {
            const buttonConfig = visibleButtons[index];
            const buttonElement = visibleButtons.length === 1 ? primaryButton : actionButtons[index];
            buttonElement.style.display = '';
            buttonElement.textContent = await resolveButtonText(buttonConfig);
            buttonElement.onclick = () => finish(buttonConfig.value);
        }

        closeButton.onclick = () => finish(closeValue);
        dialog.style.zIndex = '70';
        overlay.style.zIndex = '65';
        dialog.classList.add('flex');
        dialog.classList.remove('hidden');
        overlay.classList.remove('hidden');
    });
}

export function showInfoDialog(title, content) {
    return showDialog({
        title,
        content,
        buttons: [{ value: true, text: 'OK', primary: true }],
        closeValue: true
    });
}

export function showMessageDialog(title, content) {
    return showInfoDialog(title, content);
}

export function showConfirmDialog(title, content) {
    return showDialog({
        title,
        content,
        buttons: [
            { value: false, i18n: 'alert.no' },
            { value: true, i18n: 'alert.yes', primary: true }
        ],
        closeValue: false
    });
}

export function showDontShowDialog(title, content) {
    return showDialog({
        title,
        content,
        buttons: [
            { value: 'dont-show', i18n: 'alert.dont_show_again' },
            { value: true, i18n: 'alert.confirm', primary: true }
        ],
        closeValue: false
    });
}

export function showLegacyInfoDialog(title, content, style = 'ok') {
    if (style === 'yesno') return showConfirmDialog(title, content);
    if (style === 'dontshow-ok') return showDontShowDialog(title, content);
    return showInfoDialog(title, content);
}
