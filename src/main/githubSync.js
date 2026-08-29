const { execFile } = require('child_process');
const { randomUUID } = require('crypto');
const fsOriginal = require('original-fs');
const path = require('path');
const util = require('util');

const i18next = require('i18next');
const { format } = require('date-fns');

const { getSettings } = require('./global');
const { calculateDirectorySizeAsync } = require('./fileSystemUtils');
const {
    assertNoSymlinkAncestors,
    normalizeAbsolutePath,
    normalizeBackupDate,
    normalizeWikiId,
    resolveInside,
    validateBackupMetadata
} = require('./validation');
const { listGameBackupFolders, normalizeSyncPath, pruneBackups } = require('./syncBackupUtils');

const execFilePromise = util.promisify(execFile);
const GIT_COMMAND_TIMEOUT_MS = 120000;
const GIT_MAX_BUFFER_BYTES = 1024 * 1024 * 10;
const SAFE_GIT_CONFIG = [
    ['core.hooksPath', process.platform === 'win32' ? 'NUL' : '/dev/null'],
    ['core.fsmonitor', 'false'],
    ['core.sshCommand', 'ssh'],
    ['ssh.variant', 'ssh'],
    ['commit.gpgSign', 'false'],
    ['tag.gpgSign', 'false'],
    ['push.gpgSign', 'false'],
    ['merge.verifySignatures', 'false'],
    ['submodule.recurse', 'false'],
    ['fetch.recurseSubmodules', 'false'],
    ['push.recurseSubmodules', 'false'],
    ['gc.auto', '0'],
    ['maintenance.auto', 'false'],
    ['protocol.allow', 'never'],
    ['protocol.https.allow', 'always'],
    ['protocol.ssh.allow', 'always']
];

function safeGitEnvironment() {
    const environment = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (/^GIT(?:_|$)/i.test(key) || /^SSH_ASKPASS(?:_REQUIRE)?$/i.test(key)) continue;
        environment[key] = value;
    }
    environment.GIT_TERMINAL_PROMPT = '0';
    environment.LC_ALL = 'C';
    return environment;
}

function safeGitArguments(args) {
    return [
        '--no-pager',
        ...SAFE_GIT_CONFIG.flatMap(([key, value]) => ['-c', `${key}=${value}`]),
        ...args
    ];
}

function gitExecutionOptions(repoRoot) {
    return {
        cwd: repoRoot,
        env: safeGitEnvironment(),
        shell: false,
        windowsHide: true,
        timeout: GIT_COMMAND_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER_BYTES
    };
}

function sanitizedGitError(error) {
    return String(error?.stderr || error?.message || 'Git command failed')
        .replace(/https:\/\/[^\s/@]+(?::[^\s/@]*)?@github\.com/gi, 'https://[redacted]@github.com')
        .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, '[redacted-token]')
        .slice(0, 10000);
}

function unsafeLocalConfigCategory(configKey) {
    const key = String(configKey || '').toLowerCase();
    if (['core.sshcommand', 'core.askpass', 'core.gitproxy', 'core.alternaterefscommand'].includes(key)) {
        return 'core command';
    }
    if (key === 'gpg.program' || (key.startsWith('gpg.') && key.endsWith('.program')) || key === 'gpg.ssh.defaultkeycommand') {
        return 'signing command';
    }
    if (key.startsWith('credential.') && key.endsWith('.helper')) return 'credential helper';
    if (key.startsWith('filter.') && ['.clean', '.smudge', '.process'].some(suffix => key.endsWith(suffix))) {
        return 'content filter command';
    }
    if (key === 'diff.external' || (key.startsWith('diff.') && ['.command', '.textconv'].some(suffix => key.endsWith(suffix)))) {
        return 'diff command';
    }
    if (key.startsWith('merge.') && key.endsWith('.driver')) return 'merge command';
    if ((key.startsWith('difftool.') || key.startsWith('mergetool.')) && key.endsWith('.cmd')) return 'tool command';
    if (key.startsWith('hook.') && key.endsWith('.command')) return 'configured hook';
    if (key === 'include.path' || (key.startsWith('includeif.') && key.endsWith('.path'))) return 'configuration include';
    if (key.startsWith('url.') && ['.insteadof', '.pushinsteadof'].some(suffix => key.endsWith(suffix))) {
        return 'URL rewrite';
    }
    if (key.startsWith('remote.') && key.endsWith('.vcs')) return 'remote helper';
    if (key.startsWith('remote.') && ['.uploadpack', '.receivepack'].some(suffix => key.endsWith(suffix))) {
        return 'remote command';
    }
    if (key === 'fetch.bundleuri' || key === 'extensions.partialclone') return 'implicit fetch';
    if (key.startsWith('remote.') && ['.promisor', '.partialclonefilter'].some(suffix => key.endsWith(suffix))) {
        return 'implicit fetch';
    }
    if (key.startsWith('submodule.') && key.endsWith('.update')) return 'submodule command';
    if (key === 'gc.recentobjectshook') return 'maintenance hook';
    return '';
}

async function auditRepoLocalConfig(repoRoot) {
    let stdout;
    try {
        ({ stdout } = await execFilePromise('git', safeGitArguments([
            'config', '--no-includes', '--show-scope', '--null', '--name-only', '--list'
        ]), gitExecutionOptions(repoRoot)));
    } catch (error) {
        throw new Error(sanitizedGitError(error));
    }

    const fields = String(stdout || '').split('\0');
    if (fields.at(-1) === '') fields.pop();
    if (fields.length % 2 !== 0) throw new Error('Unable to safely audit repository Git configuration.');

    for (let index = 0; index < fields.length; index += 2) {
        const scope = fields[index].toLowerCase();
        if (scope !== 'local' && scope !== 'worktree') continue;
        const category = unsafeLocalConfigCategory(fields[index + 1]);
        if (category) throw new Error(`Unsafe repository Git configuration is not allowed: ${category}.`);
    }
}

async function runGit(repoRoot, args) {
    await auditRepoLocalConfig(repoRoot);
    try {
        const { stdout, stderr } = await execFilePromise(
            'git', safeGitArguments(args), gitExecutionOptions(repoRoot)
        );
        return `${stdout || ''}${stderr || ''}`.trim();
    } catch (error) {
        throw new Error(sanitizedGitError(error));
    }
}

async function runGitStdout(repoRoot, args, { allowExitCodes = [] } = {}) {
    await auditRepoLocalConfig(repoRoot);
    try {
        const { stdout } = await execFilePromise(
            'git', safeGitArguments(args), gitExecutionOptions(repoRoot)
        );
        return String(stdout || '');
    } catch (error) {
        if (allowExitCodes.includes(Number(error?.code))) return null;
        throw new Error(sanitizedGitError(error));
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
        const remoteUrls = await runGit(repoRoot, ['remote', 'get-url', '--all', 'origin']).catch(() => '');
        const pushRemoteUrls = await runGit(repoRoot, ['remote', 'get-url', '--push', '--all', 'origin']).catch(() => '');
        const safeRemote = sanitizeSingleGitHubRemote(remoteUrls);
        const safePushRemote = sanitizeSingleGitHubRemote(pushRemoteUrls);
        status.hasRemote = Boolean(
            safeRemote && safePushRemote
            && gitHubRepositoryIdentity(safeRemote) === gitHubRepositoryIdentity(safePushRemote)
        );
        status.remoteUrl = safeRemote;
        const shortStatus = await runGit(repoRoot, ['status', '--short', '--', '.']);
        status.dirty = shortStatus.length > 0;
        status.message = status.hasRemote ? i18next.t('alert.github_sync_ready') : i18next.t('alert.github_sync_no_remote');
    } catch (error) {
        status.hasRemote = false;
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
        if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return '';
        if (!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(parsed.pathname)) return '';
        return `https://github.com${parsed.pathname}`;
    } catch (_) {
        return '';
    }
}

function sanitizeSingleGitHubRemote(remoteUrls) {
    const values = String(remoteUrls || '').split(/\r?\n/).filter(Boolean);
    if (values.length !== 1) return '';
    return sanitizeGitHubRemote(values[0]);
}

function gitHubRepositoryIdentity(remoteUrl) {
    const value = sanitizeGitHubRemote(remoteUrl);
    if (!value) return '';
    const repositoryPath = value.startsWith('git@github.com:')
        ? value.slice('git@github.com:'.length)
        : new URL(value).pathname.slice(1);
    return repositoryPath.replace(/\.git$/i, '').toLowerCase();
}

async function remoteMainBranchExists(repoRoot) {
    const remoteMain = await runGit(repoRoot, ['ls-remote', '--heads', 'origin', 'main']);
    return remoteMain.length > 0;
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

    await runGit(repoRoot, setUpstream
        ? ['push', '-u', 'origin', 'HEAD:main']
        : ['push', 'origin', 'HEAD:main']);
    return committed;
}

function normalizeGitRevision(rawRevision, { allowMissing = false } = {}) {
    if (rawRevision == null && allowMissing) return null;
    const revision = String(rawRevision || '').trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(revision)) {
        throw new Error('Git returned an invalid revision identifier');
    }
    return revision;
}

async function getHeadRevision(repoRoot, { allowMissing = false } = {}) {
    const revision = await runGitStdout(
        repoRoot,
        ['rev-parse', '--verify', '--quiet', 'HEAD'],
        { allowExitCodes: allowMissing ? [1] : [] }
    );
    return normalizeGitRevision(revision, { allowMissing });
}

function parseNullTerminatedGitPaths(rawOutput) {
    if (rawOutput === '') return [];
    if (typeof rawOutput !== 'string' || !rawOutput.endsWith('\0')) {
        throw new Error('Git returned a malformed NUL-delimited path list');
    }
    const paths = rawOutput.slice(0, -1).split('\0');
    if (paths.some(filePath => !filePath || filePath.includes('\0'))) {
        throw new Error('Git returned an invalid changed path');
    }
    return [...new Set(paths)];
}

async function getPulledChangedPaths(repoRoot, oldRevision, newRevision) {
    if (oldRevision === newRevision) return [];
    const commonArguments = [
        '--name-only', '-z', '--diff-filter=AMT', '--no-renames'
    ];
    const argumentsForDiff = oldRevision
        ? ['diff', ...commonArguments, oldRevision, newRevision, '--']
        : ['diff-tree', '--root', '--no-commit-id', '-r', ...commonArguments, newRevision, '--'];
    return parseNullTerminatedGitPaths(await runGitStdout(repoRoot, argumentsForDiff));
}

function resolveChangedBackupMetadataPath(repoRoot, gitPath) {
    if (typeof gitPath !== 'string' || !gitPath || gitPath.length > 4096
        || gitPath.startsWith('/') || gitPath.includes('\\') || /[\r\n]/.test(gitPath)) {
        throw new Error('Remote Git history contains an unsafe backup metadata path');
    }
    const segments = gitPath.split('/');
    const metadataLike = segments.at(-1)?.toLowerCase() === 'backup_info.json';
    if (metadataLike && segments.length !== 3) {
        throw new Error('Remote Git history contains backup metadata outside <wiki>/<date>');
    }
    if (segments.length < 3) return null;
    if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
        throw new Error('Remote Git history contains an unsafe backup path');
    }

    // A remote change to any payload below a backup instance changes that
    // backup's trust boundary, even when backup_info.json itself was not part
    // of the commit. Always downgrade the owning metadata before any restore,
    // retention, stage, or push operation can observe the pulled payload.
    let wikiId;
    let backupDate;
    try {
        wikiId = normalizeWikiId(segments[0]);
        backupDate = normalizeBackupDate(segments[1]);
    } catch (error) {
        if (metadataLike) throw new Error('Remote Git history contains a non-canonical backup metadata path');
        return null;
    }
    if (wikiId !== segments[0] || backupDate !== segments[1]) {
        if (metadataLike) throw new Error('Remote Git history contains a non-canonical backup metadata path');
        return null;
    }
    return resolveInside(repoRoot, wikiId, backupDate, 'backup_info.json');
}

async function prepareExternalMetadataRewrite(repoRoot, metadataPath) {
    await assertNoSymlinkAncestors(repoRoot, metadataPath, fsOriginal);
    const stats = await fsOriginal.promises.lstat(metadataPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > 1024 * 1024) {
        throw new Error('Remote Git history contains invalid backup metadata');
    }

    const rawBuffer = await fsOriginal.promises.readFile(metadataPath);
    if (rawBuffer.length !== stats.size || rawBuffer.length > 1024 * 1024) {
        throw new Error('Remote Git backup metadata changed while it was being validated');
    }
    let rawMetadata;
    try {
        rawMetadata = JSON.parse(rawBuffer.toString('utf8'));
    } catch (_) {
        throw new Error('Remote Git history contains malformed backup metadata JSON');
    }
    const externalMetadata = validateBackupMetadata({ ...rawMetadata, provenance: 'external' });
    return rawMetadata.provenance === 'external'
        ? null
        : { metadataPath, externalMetadata };
}

async function writeExternalMetadataAtomically({ metadataPath, externalMetadata }) {
    const temporaryPath = path.join(
        path.dirname(metadataPath),
        `.backup_info.json.ogs-provenance-${randomUUID()}.tmp`
    );
    try {
        await fsOriginal.promises.writeFile(
            temporaryPath,
            `${JSON.stringify(externalMetadata, null, 4)}\n`,
            { encoding: 'utf8', flag: 'wx', mode: 0o600 }
        );
        await fsOriginal.promises.rename(temporaryPath, metadataPath);
    } finally {
        await fsOriginal.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
}

async function markPulledBackupMetadataExternal(repoRoot, changedPaths) {
    const metadataPaths = [];
    const comparisonPaths = new Set();
    for (const gitPath of changedPaths) {
        const metadataPath = resolveChangedBackupMetadataPath(repoRoot, gitPath);
        if (!metadataPath) continue;
        const comparisonPath = process.platform === 'win32' ? metadataPath.toLowerCase() : metadataPath;
        // Multiple payload files from one backup intentionally resolve to the
        // same metadata file. Validate and rewrite that owner only once.
        if (comparisonPaths.has(comparisonPath)) continue;
        comparisonPaths.add(comparisonPath);
        metadataPaths.push(metadataPath);
    }

    // Validate every affected metadata file before mutating any of them. An
    // invalid remote change must stop the sync before retention or upload can run.
    const rewrites = [];
    for (const metadataPath of metadataPaths) {
        const rewrite = await prepareExternalMetadataRewrite(repoRoot, metadataPath);
        if (rewrite) rewrites.push(rewrite);
    }
    for (const rewrite of rewrites) await writeExternalMetadataAtomically(rewrite);
}

async function pullRepo(repoRoot, { auditTrackedBackups = false } = {}) {
    const oldRevision = await getHeadRevision(repoRoot, { allowMissing: true });
    await runGit(repoRoot, ['pull', '--ff-only', 'origin', 'main']);
    const newRevision = await getHeadRevision(repoRoot);
    const changedPaths = await getPulledChangedPaths(repoRoot, oldRevision, newRevision);
    const pathsToAudit = auditTrackedBackups
        ? [
            ...changedPaths,
            ...parseNullTerminatedGitPaths(await runGitStdout(repoRoot, ['ls-files', '-z', '--']))
        ]
        : changedPaths;
    await markPulledBackupMetadataExternal(repoRoot, pathsToAudit);
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
        games: (await listGameBackupFolders(syncPath)).length
    };
}

async function downloadBackupsFromGitHub(syncPathSetting = null) {
    const syncPath = normalizeSyncPath(syncPathSetting || getSettings().backupPath || '');
    const repoRoot = syncPath;
    const status = await checkGitSyncStatus(syncPath);
    if (!status.isGitRepo || !status.hasRemote) {
        throw new Error(status.message || i18next.t('alert.github_sync_not_ready'));
    }

    // A repository may already be at origin/main the first time the user asks
    // OpenGameSave to download it. In that case there is no pull diff from
    // which provenance can be inferred, so audit every tracked backup path.
    await pullRepo(repoRoot, { auditTrackedBackups: true });
    await pruneBackups(syncPath);

    return {
        syncPath,
        repoRoot,
        size: await calculateDirectorySizeAsync(syncPath, false, fsOriginal),
        games: (await listGameBackupFolders(syncPath)).length
    };
}

module.exports = {
    checkGitSyncStatus,
    uploadBackupsToGitHub,
    downloadBackupsFromGitHub
};
