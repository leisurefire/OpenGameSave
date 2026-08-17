export function createLoadingIndicator(text) {
    const escapedText = String(text ?? '').replace(/[&<>'"]/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[character]);
    return `
        <div class="loading-indicator" data-loader-active="true">
            <span data-lucide-icon="loader-circle" class="is-spinning text-theme-accent"></span>
            <span class="text-content">${escapedText}</span>
        </div>
    `;
}
