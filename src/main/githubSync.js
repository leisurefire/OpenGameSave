const { execFile } = require('child_process');
const fsOriginal = require('original-fs');
const path = require('path');
const util = require('util');

const fse = require('fs-extra');
const i18next = require('i18next');
const { format } = require('date-fns');

const { getSettings } = require('./global');
const { calculateDirectorySizeAsync } = require('./fileSystemUtils');
const { normalizeAbsolutePath } = require('./validation');

const execFilePromise = util.promisify(execFile);

function normalizeSyncPath(inputPath) {
    const configuredPath = normalizeAbsolutePath(getSettings().backupPath);
    const requestedPath = normalizeAbsolutePath(inputPath || configuredPath);
    const normalizeForComparison = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (normalizeForComparison(requestedPath) !== normalizeForComparison(configuredPath)) {
        throw new Error('Git sync is limited to the configured backup directory');
    }
    return configuredPath;
}

async function runGit(repoRoot, args) {
    const hooksPath = process.platform === 'win32' ? 'NUL' : '/dev/null';
    try {
        const { stdout, stderr } = await execFilePromise('git', [
            '-c', `core.hooksPath=${hooksPath}`,
            '-c', 'core.fsmonitor=false',
            ...args
        ], {
            cwd: repoRoot,
            windowsHide: true,
            timeout: 120000,
            maxBuffer: 1024 * 1024 * 10
        });
        return `${stdout || ''}${stderr || ''}`.trim();
    } catch (error) {
        const message = String(error?.stderr || error?.message || 'Git command failed')
            .replace(/https:\/\/[^\s/@]+(?::[^\s/@]*)?@github\.com/gi, 'https://[redacted]@github.com')
            .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, '[redacted-token]');
        throw new Error(message.slice(0, 10000));
    }
}

async function checkGitSyncStatus(syncPathSetting = null) {
    let configuredSyncPath = '';
    try {
        configuredSyncPath = normalizeSyncPath(syncPathSetting || getSettings().backupPath || '');
    } catch (error) {
        return {
            configured: false, syncPath: '', repoRoot: '', exists: false, isGitRepo: false,
            hasRemote: false, branch: '', remoteUrl: '', dirty: false, message: error.message
        };
    }
    const repoRoot = configuredSyncPath;
    const status = {
        configured: Boolean(configuredSyncPath),
        syncPath: configuredSyncPath,
        repoRoot,
        exists: false,
        isGitRepo: false,
        hasRemote: false,
        branch: '',
        remoteUrl: '',
        dirty: false,
        message: ''
    };

    try {
        if (!configuredSyncPath) {
            status.message = i18next.t('alert.github_sync_path_required');
            return status;
        }

        const repoStats = await fsOriginal.promises.lstat(repoRoot).catch(() => null);
        status.exists = Boolean(repoStats?.isDirectory() && !repoStats.isSymbolicLink());
        if (!status.exists) {
            status.message = i18next.t('alert.github_sync_repo_missing');
            return status;
        }

        const insideTree = await runGit(repoRoot, ['rev-parse', '--is-inside-work-tree']);
        status.isGitRepo = insideTree.trim() === 'true';
        if (!status.isGitRepo) {
            status.message = i18next.t('alert.github_sync_not_git_repo');
            return status;
        }

        const topLevel = normalizeAbsolutePath(await runGit(repoRoot, ['rev-parse', '--show-toplevel']));
        const normalizeForComparison = value => process.platform === 'win32' ? value.toLowerCase() : value;
        if (normalizeForComparison(topLevel) !== normalizeForComparison(repoRoot)) {
            status.isGitRepo = false;
            status.message = i18next.t('alert.github_sync_not_git_repo');
            return status;
        }

        status.branch = await runGit(repoRoot, ['branch', '--show-current']);
        const remoteUrl = await runGit(repoRoot, ['remote', 'get-url', 'origin']).catch(() => '');
        const safeRemote = sanitizeGitHubRemote(remoteUrl);
        status.hasRemote = Boolean(safeRemote);
        status.remoteUrl = safeRemote;
        const shortStatus = await runGit(repoRoot, ['status', '--short', '--', '.']);
        status.dirty = shortStatus.length > 0;
        status.message = status.hasRemote ? i18next.t('alert.github_sync_ready') : i18next.t('alert.github_sync_no_remote');
    } catch (error) {
        status.message = error.message;
    }

    return status;
}

function sanitizeGitHubRemote(remoteUrl) {
    const value = String(remoteUrl || '').trim();
    if (/^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/i.test(value)) return value;
    if (/^ssh:\/\/git@github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/i.test(value)) return value;
    try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') return '';
        if (!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(parsed.pathname)) return '';
        return `https://github.com${parsed.pathname}`;
    } catch (_) {
        return '';
    }
}

function isBackupInstanceFolder(folderPath) {
    try {
        const stats = fsOriginal.lstatSync(path.join(folderPath, 'backup_info.json'));
        return stats.isFile() && !stats.isSymbolicLink() && stats.size <= 1024 * 1024;
    } catch (_) {
        return false;
    }
}

function listDirectoryFolders(rootPath) {
    if (!rootPath || !fsOriginal.existsSync(rootPath)) return [];
    return fsOriginal.readdirSync(rootPath, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
}

function listGameBackupFolders(rootPath) {
    return listDirectoryFolders(rootPath).filter(item => {
        const gamePath = path.join(rootPath, item);
        return listDirectoryFolders(gamePath).some(backup => isBackupInstanceFolder(path.join(gamePath, backup)));
    });
}

function listBackupInstanceFolders(gamePath) {
    return listDirectoryFolders(gamePath).filter(backup => isBackupInstanceFolder(path.join(gamePath, backup)));
}

async function pruneBackups(rootPath) {
    const maxBackups = Number(getSettings().maxBackups) || 5;
    if (!rootPath || !fsOriginal.existsSync(rootPath)) return;

    for (const gameId of listGameBackupFolders(rootPath)) {
        const gamePath = path.join(rootPath, gameId);
        const permanentBackups = [];
        const nonPermanentBackups = [];

        for (const backup of listBackupInstanceFolders(gamePath)) {
            const infoPath = path.join(gamePath, backup, 'backup_info.json');
            if (fsOriginal.existsSync(infoPath)) {
                try {
                    const info = await fse.readJson(infoPath);
                    if (info.is_permanent) {
                        permanentBackups.push(backup);
                        continue;
                    }
                } catch (_) {
                    // Treat unreadable metadata as non-permanent so it follows normal retention.
                }
            }
            nonPermanentBackups.push(backup);
        }

        nonPermanentBackups.sort((a, b) => b.localeCompare(a));
        const backupsToDelete = nonPermanentBackups.slice(maxBackups);
        for (const backup of backupsToDelete) {
            fsOriginal.rmSync(path.join(gamePath, backup), { recursive: true, force: true });
        }

        const remaining = [...permanentBackups, ...nonPermanentBackups.slice(0, maxBackups)];
        if (remaining.length === 0) {
            fsOriginal.rmSync(gamePath, { recursive: true, force: true });
        }
    }
}

async function remoteMainBranchExists(repoRoot) {
    try {
        const remoteMain = await runGit(repoRoot, ['ls-remote', '--heads', 'origin', 'main']);
        return remoteMain.length > 0;
    } catch (_) {
        return false;
    }
}

async function commitAndPush(repoRoot, setUpstream = false) {
    await runGit(repoRoot, ['add', '--all', '--', '.']);
    const shortStatus = await runGit(repoRoot, ['status', '--short', '--', '.']);
    let committed = false;

    if (shortStatus.length > 0) {
        await runGit(repoRoot, ['commit', '-m', `OpenGameSave backup ${format(new Date(), 'yyyy-MM-dd HH:mm')}`]);
        committed = true;
    } else if (setUpstream) {
        await runGit(repoRoot, ['commit', '--allow-empty', '-m', `OpenGameSave backup ${format(new Date(), 'yyyy-MM-dd HH:mm')}`]);
        committed = true;
    }

    await runGit(repoRoot, setUpstream ? ['push', '-u', 'origin', 'HEAD:main'] : ['push']);
    return committed;
}

async function pullRepo(repoRoot) {
    await runGit(repoRoot, ['pull', '--ff-only', 'origin', 'main']);
}

async function uploadBackupsToGitHub(syncPathSetting = null) {
    const syncPath = normalizeSyncPath(syncPathSetting || getSettings().backupPath || '');
    const repoRoot = syncPath;
    const status = await checkGitSyncStatus(syncPath);
    if (!status.isGitRepo || !status.hasRemote) {
        throw new Error(status.message || i18next.t('alert.github_sync_not_ready'));
    }

    const hasRemoteMainBranch = await remoteMainBranchExists(repoRoot);
    if (hasRemoteMainBranch) {
        await pullRepo(repoRoot);
    }

    await pruneBackups(syncPath);
    const committed = await commitAndPush(repoRoot, !hasRemoteMainBranch);

    return {
        committed,
        syncPath,
        repoRoot,
        size: await calculateDirectorySizeAsync(syncPath, false, fsOriginal),
        games: listGameBackupFolders(syncPath).length
    };
}

async function downloadBackupsFromGitHub(syncPathSetting = null) {
    const syncPath = normalizeSyncPath(syncPathSetting || getSettings().backupPath || '');
    const repoRoot = syncPath;
    const status = await checkGitSyncStatus(syncPath);
    if (!status.isGitRepo || !status.hasRemote) {
        throw new Error(status.message || i18next.t('alert.github_sync_not_ready'));
    }

    await pullRepo(repoRoot);
    await pruneBackups(syncPath);

    return {
        syncPath,
        repoRoot,
        size: await calculateDirectorySizeAsync(syncPath, false, fsOriginal),
        games: listGameBackupFolders(syncPath).length
    };
}

module.exports = {
    checkGitSyncStatus,
    uploadBackupsToGitHub,
    downloadBackupsFromGitHub
};
