function normalizeDialogContent(content) {
    if (typeof content === 'function') {
        throw new Error('Function-based in-page dialog content is no longer supported. Use a dedicated BrowserWindow dialog helper.');
    }

    return content;
}

async function invokeDialogWindow(dialogData) {
    const response = await window.api.invoke('show-dialog-modal-window', dialogData);
    return response && Object.prototype.hasOwnProperty.call(response, 'value') ? response.value : response;
}

export async function showDialog({
    title,
    content,
    iconType,
    buttons = [{ value: true, i18n: 'alert.confirm', primary: true }],
    closeValue = true,
    afterClose
}) {
    const value = await invokeDialogWindow({
        title,
        content: normalizeDialogContent(content),
        iconType,
        buttons,
        closeValue
    });

    if (afterClose) afterClose(value);
    return value;
}

export function showInfoDialog(title, content) {
    return showDialog({
        title,
        content,
        buttons: [{ value: true, i18n: 'alert.confirm', primary: true }],
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
        iconType: 'warning',
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
        iconType: 'info',
        buttons: [
            { value: 'dont-show', i18n: 'alert.dont_show_again' },
            { value: true, i18n: 'alert.confirm', primary: true }
        ],
        closeValue: false
    });
}

export async function showRestoreConflictDialog(prompt) {
    const replaceLabel = await window.i18n.translate('alert.yes');
    const skipLabel = await window.i18n.translate('alert.no');
    const response = await window.api.invoke('show-dialog-modal-window', {
        title: prompt.title,
        content: prompt.message,
        iconType: 'warning',
        checkbox: { label: prompt.checkboxLabel },
        buttons: [
            { value: 'skip', text: skipLabel },
            { value: 'replace', text: replaceLabel, primary: true }
        ],
        closeValue: 'skip'
    });

    return {
        choice: response?.value || 'skip',
        doForAll: !!response?.checked
    };
}

