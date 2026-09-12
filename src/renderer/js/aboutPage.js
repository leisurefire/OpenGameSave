import { showAlert, updateTranslations } from './utility.js';

let displayedLatestVersion = null;

window.api.receive('apply-language', async () => {
    await updateTranslations(document);
    const latestVersionSpan = document.getElementById('latest-version');
    if (latestVersionSpan && displayedLatestVersion !== null) {
        latestVersionSpan.removeAttribute('data-i18n');
        latestVersionSpan.innerText = displayedLatestVersion;
    }
});

async function initializeAboutPage() {
    const latestVersionSpan = document.getElementById('latest-version');
    const currentVersionSpan = document.getElementById('current-version');
    const githubLink = document.getElementById('github-link');
    const authorLink = document.getElementById('author-link');
    const updateButton = document.getElementById('update-button');
    const appLicenseLink = document.getElementById('app-license-link');
    const noticesToggle = document.getElementById('notices-toggle');
    const noticesPanel = document.getElementById('about-notices');

    const fetchLatestVersion = async () => {
        try {
            const currentVersion = await window.api.invoke('get-current-version');
            currentVersionSpan.innerText = currentVersion;
            const latestVersion = await window.api.invoke('get-latest-version');
            if (!latestVersion) throw new Error('Latest version is unavailable');
            displayedLatestVersion = latestVersion;

            // A resolved version is data, not the initial loading translation.
            // Leaving this attribute set replaces the version on language changes.
            latestVersionSpan.removeAttribute('data-i18n');
            latestVersionSpan.innerText = latestVersion;
            latestVersionSpan.classList.remove('version-status-error');
            const updateAvailable = await window.api.invoke('is-newer-version', latestVersion, currentVersion);
            latestVersionSpan.classList.toggle('version-status-success', updateAvailable);
            updateButton.classList.toggle('hidden', !updateAvailable);
        } catch (error) {
            displayedLatestVersion = null;
            console.error('Failed to check application version:', error);
            latestVersionSpan.setAttribute('data-i18n', 'about.load_failed');
            latestVersionSpan.innerText = await window.i18n.translate('about.load_failed');
            latestVersionSpan.classList.add('version-status-error');
            latestVersionSpan.classList.remove('version-status-success');
            updateButton.classList.add('hidden');
        }
    };

    updateButton.addEventListener('click', async () => {
        updateButton.disabled = true;
        updateButton.setAttribute('aria-busy', 'true');
        updateButton.dataset.i18n = 'about.downloading_update';
        try {
            updateButton.textContent = await window.i18n.translate('about.downloading_update');
            const result = await window.api.invoke('download-app-update');
            if (result?.status === 'error') {
                await showAlert('error', await window.i18n.translate(
                    result.error === 'app-busy' ? 'settings.app_update_busy' : 'settings.app_update_failed'
                ));
            }
        } catch (error) {
            console.error('Failed to start application update:', error);
            await showAlert('error', await window.i18n.translate('settings.app_update_failed'));
        } finally {
            updateButton.disabled = false;
            updateButton.removeAttribute('aria-busy');
            updateButton.dataset.i18n = 'about.update';
            updateButton.textContent = await window.i18n.translate('about.update');
        }
    });

    try {
        await updateTranslations(document);
    } finally {
        document.body.style.visibility = 'visible';
        void fetchLatestVersion();
    }

    githubLink.addEventListener('click', async () => {
        const repositoryUrl = await window.api.invoke('get-repository-url');
        window.api.invoke('open-url', repositoryUrl);
    });
    authorLink.addEventListener('click', () => {
        window.api.invoke('open-url', 'https://github.com/leisurefire');
    });
    appLicenseLink.addEventListener('click', () => {
        window.api.invoke('open-url', 'https://www.gnu.org/licenses/gpl-3.0.html');
    });
    noticesToggle.addEventListener('click', async () => {
        const willShow = noticesPanel.classList.contains('hidden');
        noticesPanel.classList.toggle('hidden', !willShow);
        noticesToggle.setAttribute('aria-expanded', String(willShow));
        noticesToggle.dataset.i18n = willShow ? 'about.hide_notices' : 'about.view_notices';
        noticesToggle.textContent = await window.i18n.translate(noticesToggle.dataset.i18n);
    });
    document.querySelectorAll('[data-external-url]').forEach(link => link.addEventListener('click', () => {
        window.api.invoke('open-url', link.dataset.externalUrl);
    }));
}

if (document.readyState === 'interactive' || document.readyState === 'complete') {
    void initializeAboutPage();
} else {
    document.addEventListener('DOMContentLoaded', initializeAboutPage, { once: true });
}
