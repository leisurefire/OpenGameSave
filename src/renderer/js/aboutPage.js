import { updateTranslations } from './utility.js';

window.api.receive('apply-language', async () => {
    await updateTranslations(document);
});

document.addEventListener('DOMContentLoaded', async () => {
    const latestVersionSpan = document.getElementById('latest-version');
    const currentVersionSpan = document.getElementById('current-version');
    const githubLink = document.getElementById('github-link');
    const authorLink = document.getElementById('author-link');
    const updateButton = document.getElementById('update-button');
    const appLicenseLink = document.getElementById('app-license-link');
    const noticesToggle = document.getElementById('notices-toggle');
    const noticesPanel = document.getElementById('about-notices');

    const fetchLatestVersion = async () => {
        const currentVersion = await window.api.invoke('get-current-version');
        currentVersionSpan.innerText = currentVersion;

        const failedMessage = await window.api.invoke('translate', 'about.load_failed');
        const latestVersion = await window.api.invoke('get-latest-version');

        if (latestVersion) {
            latestVersionSpan.innerText = latestVersion;
        } else {
            latestVersionSpan.innerText = failedMessage;
            latestVersionSpan.classList.add('version-status-error');
        }

        const updateAvailable = latestVersion
            ? await window.api.invoke('is-newer-version', latestVersion, currentVersion)
            : false;

        if (updateAvailable) {
            currentVersionSpan.classList.add('version-status-error');
            latestVersionSpan.classList.remove('version-status-error');
            latestVersionSpan.classList.add('version-status-success');

            updateButton.classList.remove('hidden');
            updateButton.addEventListener('click', async () => {
                updateButton.disabled = true;
                try {
                    const result = await window.api.invoke('download-app-update');
                    if (result?.fallbackOpened || result?.status === 'error') {
                        updateButton.disabled = false;
                    }
                } catch (error) {
                    console.error('Failed to start application update:', error);
                    updateButton.disabled = false;
                }
            });
        }
    };

    fetchLatestVersion();
    await updateTranslations(document);
    document.body.style.visibility = 'visible';

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
});
