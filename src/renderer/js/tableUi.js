import { renderIcon } from './icons.js';
import { createLoadingIndicator } from './loadingIndicator.js';

export async function setActionButtonState({ button, icon, text, iconName, i18nKey, busy }) {
    button.disabled = busy;
    button.classList.toggle('cursor-not-allowed', busy);
    icon.classList.toggle('is-spinning', busy);
    renderIcon(icon, busy ? 'loader-circle' : iconName);
    text.setAttribute('data-i18n', i18nKey);
    text.textContent = await window.i18n.translate(i18nKey);
}

export async function showLoadingIndicator(tabName) {
    const loadingContainer = document.getElementById(`${tabName}-loading`);
    const actionSummary = document.querySelector(`#${tabName}-summary`);
    const contentContainer = document.getElementById(`${tabName}-content`);
    const actionButton = document.getElementById(`${tabName}-button`);
    actionSummary.classList.add('hidden');
    document.querySelector(`#${tabName}-summary-done`).classList.add('hidden');
    actionButton.disabled = true;
    actionButton.classList.add('cursor-not-allowed', 'opacity-50');

    if (contentContainer && window.getComputedStyle(contentContainer).display !== 'none') {
        contentContainer.classList.remove('animate-fadeInShift');
        contentContainer.classList.add('animate-fadeOut');
        await new Promise((resolve) => {
            setTimeout(resolve, 300);
        });
        contentContainer.classList.add('hidden');
    }
    if (loadingContainer) {
        const loadingText = await window.i18n.translate(loadingContainer.getAttribute('data-i18n'));
        loadingContainer.innerHTML = createLoadingIndicator(loadingText);
        loadingContainer.classList.remove('hidden');
    }
}

export function hideLoadingIndicator(tabName) {
    const loadingContainer = document.getElementById(`${tabName}-loading`);
    const contentContainer = document.getElementById(`${tabName}-content`);
    const actionButton = document.getElementById(`${tabName}-button`);
    actionButton.disabled = false;
    actionButton.classList.remove('cursor-not-allowed', 'opacity-50');
    loadingContainer?.classList.add('hidden');
    if (contentContainer) {
        contentContainer.classList.remove('hidden', 'animate-fadeOut');
        contentContainer.classList.add('animate-fadeInShift');
    }
}
