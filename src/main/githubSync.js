const { execFile } = require('child_process');
const fsOriginal = require('original-fs');
const path = require('path');
const util = require('util');

const fse = require('fs-extra');
const i18next = require('i18next');
const moment = require('moment');

const { calculateDirectorySize, getSettings } = require('./global');

const execFilePromise = util.promisify(execFile);

function normalizeSyncPath(inputPath) {
    return inputPath || '';
}

function getRepoRootFromSyncPath(syncPath) {
    return syncPath || '';
}

async function runGit(repoRoot, args) {
    const { stdout, stderr } = await execFilePromise('git', args, {
        cwd: repoRoot,
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 1024 * 1024 * 10
    });
    return `${stdout || ''}${stderr || ''}`.trim();
}

async function checkGitSyncStatus(syncPathSetting = null) {
    const configuredSyncPath = normalizeSyncPath(syncPathSetting || getSettings().backupPath || '');
    const repoRoot = getRepoRootFromSyncPath(configuredSyncPath);
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

        status.exists = fsOriginal.existsSync(repoRoot);
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

        status.branch = await runGit(repoRoot, ['branch', '--show-current']);
        const remotes = await runGit(repoRoot, ['remote', '-v']);
        status.hasRemote = remotes.length > 0;
        status.remoteUrl = remotes.split(/\r?\n/)[0] || '';
        const shortStatus = await runGit(repoRoot, ['status', '--short']);
        status.dirty = shortStatus.length > 0;
        status.message = status.hasRemote ? i18next.t('alert.github_sync_ready') : i18next.t('alert.github_sync_no_remote');
    } catch (error) {
        status.message = error.message;
    }

    return status;
}

function isBackupInstanceFolder(folderPath) {
    return fsOriginal.existsSync(path.join(folderPath, 'backup_info.json'));
}

function listDirectoryFolders(rootPath) {
    if (!rootPath || !fsOriginal.existsSync(rootPath)) return [];
    return fsOriginal.readdirSync(rootPath).filter(item => {
        const fullPath = path.join(rootPath, item);
        return fsOriginal.existsSync(fullPath) && fsOriginal.lstatSync(fullPath).isDirectory();
    });
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

async function ensureLocalMainBranch(repoRoot) {
    await runGit(repoRoot, ['checkout', '-B', 'main']);
}

async function commitAndPush(repoRoot, setUpstream = false) {
    await runGit(repoRoot, ['add', '.']);
    const shortStatus = await runGit(repoRoot, ['status', '--short']);
    let committed = false;

    if (shortStatus.length > 0) {
        await runGit(repoRoot, ['commit', '-m', `OpenGameSave backup ${moment().format('YYYY-MM-DD HH:mm')}`]);
        committed = true;
    } else if (setUpstream) {
        await runGit(repoRoot, ['commit', '--allow-empty', '-m', `OpenGameSave backup ${moment().format('YYYY-MM-DD HH:mm')}`]);
        committed = true;
    }

    await runGit(repoRoot, setUpstream ? ['push', '-u', 'origin', 'HEAD:main'] : ['push']);
    return committed;
}

async function pullRepo(repoRoot) {
    await runGit(repoRoot, ['pull', '--ff-only']);
}

async function uploadBackupsToGitHub(syncPathSetting = null) {
    const syncPath = normalizeSyncPath(syncPathSetting || getSettings().backupPath || '');
    const repoRoot = getRepoRootFromSyncPath(syncPath);
    const status = await checkGitSyncStatus(syncPath);
    if (!status.isGitRepo || !status.hasRemote) {
        throw new Error(status.message || i18next.t('alert.github_sync_not_ready'));
    }

    const hasRemoteMainBranch = await remoteMainBranchExists(repoRoot);
    if (hasRemoteMainBranch) {
        await pullRepo(repoRoot);
    } else {
        await ensureLocalMainBranch(repoRoot);
    }

    await pruneBackups(syncPath);
    const committed = await commitAndPush(repoRoot, !hasRemoteMainBranch);

    return {
        committed,
        syncPath,
        repoRoot,
        size: calculateDirectorySize(syncPath, false),
        games: listGameBackupFolders(syncPath).length
    };
}

async function downloadBackupsFromGitHub(syncPathSetting = null) {
    const syncPath = normalizeSyncPath(syncPathSetting || getSettings().backupPath || '');
    const repoRoot = getRepoRootFromSyncPath(syncPath);
    const status = await checkGitSyncStatus(syncPath);
    if (!status.isGitRepo || !status.hasRemote) {
        throw new Error(status.message || i18next.t('alert.github_sync_not_ready'));
    }

    await pullRepo(repoRoot);
    await pruneBackups(syncPath);

    return {
        syncPath,
        repoRoot,
        size: calculateDirectorySize(syncPath, false),
        games: listGameBackupFolders(syncPath).length
    };
}

module.exports = {
    normalizeSyncPath,
    checkGitSyncStatus,
    uploadBackupsToGitHub,
    downloadBackupsFromGitHub
};
