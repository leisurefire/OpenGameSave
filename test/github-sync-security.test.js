const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const util = require('node:util');

const validation = require('../src/main/validation');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.join(PROJECT_ROOT, 'mock-github-sync-repo');

function scopedConfigOutput(entries) {
    if (entries.length === 0) return '';
    return `${entries.flatMap(({ scope = 'local', key }) => [scope, key]).join('\0')}\0`;
}

function requireWithMocks(relativePath, mocks) {
    const modulePath = path.join(PROJECT_ROOT, relativePath);
    const originalLoad = Module._load;
    Module._load = function loadWithTestMocks(request, parent, isMain) {
        if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
        return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve(modulePath)];
    try {
        return require(modulePath);
    } finally {
        Module._load = originalLoad;
    }
}

function loadGithubSync({
    configEntries = [], remoteUrl = 'https://github.com/openai/example.git', pushRemoteUrl = remoteUrl,
    failCommand = '', repoRoot = REPO_ROOT, fsAdapter = null, gitCommand = null,
    onPrune = async () => {}
} = {}) {
    const calls = [];
    function execFile() {
        throw new Error('The callback form is not expected in this test.');
    }
    execFile[util.promisify.custom] = async (file, args, options) => {
        calls.push({ file, args, options });
        if (args.includes('--show-scope')) return { stdout: scopedConfigOutput(configEntries), stderr: '' };
        if (failCommand && args.includes(failCommand)) {
            throw Object.assign(new Error(`injected ${failCommand} failure`), { stderr: `injected ${failCommand} failure` });
        }
        if (gitCommand) {
            const customResult = await gitCommand(args);
            if (customResult !== undefined) return customResult;
        }
        const revParseIndex = args.indexOf('rev-parse');
        if (revParseIndex >= 0 && args[revParseIndex + 1] === '--is-inside-work-tree') {
            return { stdout: 'true\n', stderr: '' };
        }
        if (revParseIndex >= 0 && args[revParseIndex + 1] === '--show-toplevel') {
            return { stdout: `${repoRoot}\n`, stderr: '' };
        }
        const remoteIndex = args.indexOf('remote');
        if (remoteIndex >= 0 && args[remoteIndex + 1] === 'get-url') {
            return { stdout: `${args.includes('--push') ? pushRemoteUrl : remoteUrl}\n`, stderr: '' };
        }
        if (args.includes('branch')) return { stdout: 'main\n', stderr: '' };
        if (args.includes('status')) return { stdout: '', stderr: '' };
        throw new Error(`Unexpected Git invocation: ${args.join(' ')}`);
    };

    const githubSync = requireWithMocks('src/main/githubSync.js', {
        child_process: { execFile },
        'original-fs': fsAdapter || {
            promises: {
                lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false })
            }
        },
        i18next: { t: key => key },
        './global': { getSettings: () => ({ backupPath: repoRoot }) },
        './fileSystemUtils': { calculateDirectorySizeAsync: async () => 0 },
        './validation': validation,
        './syncBackupUtils': {
            listGameBackupFolders: async () => [],
            normalizeSyncPath: value => path.resolve(value),
            pruneBackups: onPrune
        }
    });
    return { githubSync, calls };
}

function assertConfigOverride(args, key, value) {
    const entry = `${key}=${value}`;
    assert.ok(args.some((argument, index) => argument === entry && args[index - 1] === '-c'), `missing ${entry}`);
}

function saveEnvironment(keys) {
    return new Map(keys.map(key => [key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined]));
}

function restoreEnvironment(saved) {
    for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

test('every Git operation is preflighted with fixed config and a sanitized environment', async () => {
    const inheritedKeys = [
        'GIT_SSH_COMMAND', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0',
        'GIT_ASKPASS', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE'
    ];
    const savedEnvironment = saveEnvironment(inheritedKeys);
    Object.assign(process.env, {
        GIT_SSH_COMMAND: 'malicious-ssh',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: '!malicious-helper',
        GIT_ASKPASS: 'malicious-git-askpass',
        SSH_ASKPASS: 'malicious-ssh-askpass',
        SSH_ASKPASS_REQUIRE: 'force'
    });

    try {
        const { githubSync, calls } = loadGithubSync({
            configEntries: [
                { scope: 'system', key: 'filter.lfs.process' },
                { scope: 'global', key: 'credential.helper' }
            ]
        });
        const status = await githubSync.checkGitSyncStatus(REPO_ROOT);
        assert.equal(status.isGitRepo, true);
        assert.equal(status.hasRemote, true);

        assert.equal(calls.length % 2, 0);
        for (let index = 0; index < calls.length; index += 2) {
            const audit = calls[index];
            const operation = calls[index + 1];
            assert.equal(audit.file, 'git');
            assert.ok(audit.args.includes('config'));
            assert.ok(audit.args.includes('--no-includes'));
            assert.ok(audit.args.includes('--show-scope'));
            assert.ok(audit.args.includes('--name-only'));
            assert.equal(operation.args.includes('config'), false);
        }

        for (const { args, options } of calls) {
            assert.equal(args[0], '--no-pager');
            assert.equal(options.shell, false);
            assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
            assert.equal(options.env.GIT_SSH_COMMAND, undefined);
            assert.equal(options.env.GIT_CONFIG_COUNT, undefined);
            assert.equal(options.env.GIT_CONFIG_KEY_0, undefined);
            assert.equal(options.env.GIT_CONFIG_VALUE_0, undefined);
            assert.equal(options.env.GIT_ASKPASS, undefined);
            assert.equal(options.env.SSH_ASKPASS, undefined);
            assert.equal(options.env.SSH_ASKPASS_REQUIRE, undefined);
            assertConfigOverride(args, 'core.hooksPath', process.platform === 'win32' ? 'NUL' : '/dev/null');
            assertConfigOverride(args, 'core.fsmonitor', 'false');
            assertConfigOverride(args, 'core.sshCommand', 'ssh');
            assertConfigOverride(args, 'ssh.variant', 'ssh');
            assertConfigOverride(args, 'commit.gpgSign', 'false');
            assertConfigOverride(args, 'push.gpgSign', 'false');
            assertConfigOverride(args, 'protocol.allow', 'never');
            assertConfigOverride(args, 'protocol.https.allow', 'always');
            assertConfigOverride(args, 'protocol.ssh.allow', 'always');
        }
        const remoteCalls = calls.filter(({ args }) => args.includes('remote'));
        assert.ok(remoteCalls.length > 0);
        assert.ok(remoteCalls.every(({ args }) => args.includes('--all')));
        assert.ok(remoteCalls.some(({ args }) => args.includes('--push')));
    } finally {
        restoreEnvironment(savedEnvironment);
    }
});

test('repo-local and worktree command-bearing Git config fails closed before an operation', async (context) => {
    const unsafeEntries = [
        { key: 'core.sshCommand' },
        { key: 'credential.helper' },
        { key: 'credential.https://github.com.helper' },
        { key: 'filter.backup.clean' },
        { key: 'filter.backup.smudge' },
        { scope: 'worktree', key: 'filter.backup.process' },
        { key: 'gpg.program' },
        { key: 'gpg.ssh.program' },
        { key: 'diff.backup.command' },
        { key: 'merge.backup.driver' },
        { key: 'hook.backup.command' },
        { key: 'include.path' },
        { key: 'includeIf.onbranch:main.path' },
        { key: 'url.ext::malicious.insteadOf' },
        { key: 'remote.origin.vcs' },
        { key: 'remote.origin.uploadpack' },
        { key: 'remote.origin.receivepack' },
        { key: 'fetch.bundleURI' },
        { key: 'extensions.partialClone' },
        { key: 'remote.origin.promisor' },
        { key: 'remote.origin.partialCloneFilter' },
        { key: 'submodule.example.update' },
        { key: 'gc.recentObjectsHook' }
    ];

    for (const entry of unsafeEntries) {
        await context.test(`${entry.scope || 'local'} ${entry.key}`, async () => {
            const { githubSync, calls } = loadGithubSync({ configEntries: [entry] });
            const status = await githubSync.checkGitSyncStatus(REPO_ROOT);
            assert.match(status.message, /Unsafe repository Git configuration is not allowed/);
            assert.equal(calls.length, 1);
            assert.ok(calls[0].args.includes('config'));
        });
    }
});

test('GitHub HTTPS and direct SSH remotes remain accepted', async (context) => {
    const remotes = [
        'https://github.com/openai/example.git',
        'git@github.com:openai/example.git',
        'ssh://git@github.com/openai/example.git'
    ];
    for (const remoteUrl of remotes) {
        await context.test(remoteUrl, async () => {
            const { githubSync } = loadGithubSync({ remoteUrl });
            const status = await githubSync.checkGitSyncStatus(REPO_ROOT);
            assert.equal(status.hasRemote, true);
            assert.equal(status.remoteUrl, remoteUrl);
        });
    }

    await context.test('HTTPS fetch with SSH push to the same repository', async () => {
        const { githubSync } = loadGithubSync({
            remoteUrl: 'https://github.com/openai/example.git',
            pushRemoteUrl: 'git@github.com:openai/example.git'
        });
        const status = await githubSync.checkGitSyncStatus(REPO_ROOT);
        assert.equal(status.hasRemote, true);
    });
});

test('an unsafe origin push URL is rejected even when its fetch URL is GitHub', async () => {
    const { githubSync } = loadGithubSync({ pushRemoteUrl: 'ext::malicious-command' });
    const status = await githubSync.checkGitSyncStatus(REPO_ROOT);
    assert.equal(status.hasRemote, false);
    assert.equal(status.remoteUrl, 'https://github.com/openai/example.git');
    assert.equal(status.message, 'alert.github_sync_no_remote');
});

test('multiple push URLs and a different push repository are rejected', async () => {
    const multiple = loadGithubSync({
        pushRemoteUrl: 'https://github.com/openai/example.git\next::malicious-command'
    });
    assert.equal((await multiple.githubSync.checkGitSyncStatus(REPO_ROOT)).hasRemote, false);

    const differentRepository = loadGithubSync({ pushRemoteUrl: 'git@github.com:openai/other.git' });
    assert.equal((await differentRepository.githubSync.checkGitSyncStatus(REPO_ROOT)).hasRemote, false);
});

test('GitHub HTTPS remotes reject authority and URL components that are not executed as displayed', async (context) => {
    const unsafeRemotes = [
        'https://user@github.com/openai/example.git',
        'https://github.com:8443/openai/example.git',
        'https://github.com/openai/example.git?upload=1',
        'https://github.com/openai/example.git#fragment'
    ];
    for (const remoteUrl of unsafeRemotes) {
        await context.test(remoteUrl, async () => {
            const { githubSync } = loadGithubSync({ remoteUrl });
            const status = await githubSync.checkGitSyncStatus(REPO_ROOT);
            assert.equal(status.hasRemote, false);
            assert.equal(status.remoteUrl, '');
        });
    }
});

test('a late status failure clears readiness instead of allowing sync to continue', async () => {
    const { githubSync } = loadGithubSync({ failCommand: 'status' });
    const status = await githubSync.checkGitSyncStatus(REPO_ROOT);
    assert.equal(status.isGitRepo, true);
    assert.equal(status.hasRemote, false);
    assert.match(status.message, /injected status failure/);
});

test('an ls-remote failure aborts upload before staging or pushing', async () => {
    const { githubSync, calls } = loadGithubSync({ failCommand: 'ls-remote' });
    await assert.rejects(githubSync.uploadBackupsToGitHub(REPO_ROOT), /injected ls-remote failure/);
    assert.equal(calls.some(({ args }) => args.includes('add')), false);
    assert.equal(calls.some(({ args }) => args.includes('commit')), false);
    assert.equal(calls.some(({ args }) => args.includes('push')), false);
});

function createPullGitCommand(changedPathOutput, {
    oldRevision = '1'.repeat(40),
    newRevision = '2'.repeat(40),
    trackedPathOutput = changedPathOutput
} = {}) {
    let headReadCount = 0;
    return async (args) => {
        if (args.includes('ls-remote')) {
            return { stdout: `${newRevision}\trefs/heads/main\n`, stderr: '' };
        }
        if (args.includes('rev-parse') && args.includes('--verify') && args.includes('HEAD')) {
            headReadCount += 1;
            return { stdout: `${headReadCount === 1 ? oldRevision : newRevision}\n`, stderr: '' };
        }
        if (args.includes('pull')) return { stdout: 'Already up to date.\n', stderr: '' };
        if (args.includes('diff')) return { stdout: changedPathOutput, stderr: '' };
        if (args.includes('ls-files')) return { stdout: trackedPathOutput, stderr: '' };
        if (args.includes('add') || args.includes('push') || args.includes('commit')) {
            return { stdout: '', stderr: '' };
        }
        return undefined;
    };
}

async function createBackupMetadataFixture(context, metadata = {}) {
    const repoRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ogs-git-provenance-'));
    context.after(() => fs.promises.rm(repoRoot, { recursive: true, force: true }));
    const wikiId = '1234';
    const backupDate = '2026-08-29_12-30';
    const metadataPath = path.join(repoRoot, wikiId, backupDate, 'backup_info.json');
    await fs.promises.mkdir(path.dirname(metadataPath), { recursive: true });
    await fs.promises.writeFile(metadataPath, JSON.stringify({
        title: 'Remote game',
        zh_CN: null,
        backup_paths: [{
            folder_name: 'path1',
            template: 'C:\\Users\\player\\RemoteGame',
            type: 'folder',
            install_folder: null
        }],
        provenance: 'local',
        is_permanent: false,
        custom_name: '',
        ...metadata
    }));
    return { repoRoot, wikiId, backupDate, metadataPath };
}

for (const [label, methodName] of [
    ['upload', 'uploadBackupsToGitHub'],
    ['download', 'downloadBackupsFromGitHub']
]) {
    test(`${label} downgrades remotely changed local provenance before retention`, async (context) => {
        const fixture = await createBackupMetadataFixture(context);
        const events = [];
        const gitCommand = createPullGitCommand(`${fixture.wikiId}/${fixture.backupDate}/backup_info.json\0`);
        const { githubSync, calls } = loadGithubSync({
            repoRoot: fixture.repoRoot,
            fsAdapter: fs,
            gitCommand,
            onPrune: async () => events.push('prune')
        });

        await githubSync[methodName](fixture.repoRoot);

        const rewritten = JSON.parse(await fs.promises.readFile(fixture.metadataPath, 'utf8'));
        assert.equal(rewritten.provenance, 'external');
        assert.deepEqual(events, ['prune']);
        const pullIndex = calls.findIndex(({ args }) => args.includes('pull'));
        const pruneBoundaryIndex = calls.findIndex(({ args }) => args.includes('add'));
        if (methodName === 'uploadBackupsToGitHub') assert.ok(pruneBoundaryIndex > pullIndex);
    });
}

test('a remotely changed payload downgrades its owning backup provenance', async (context) => {
    const fixture = await createBackupMetadataFixture(context);
    const payloadPath = path.join(
        fixture.repoRoot,
        fixture.wikiId,
        fixture.backupDate,
        'path1',
        'remote-payload.exe'
    );
    await fs.promises.mkdir(path.dirname(payloadPath), { recursive: true });
    await fs.promises.writeFile(payloadPath, 'remote executable payload');
    const relativePayloadPath = `${fixture.wikiId}/${fixture.backupDate}/path1/remote-payload.exe`;
    const gitCommand = createPullGitCommand(`${relativePayloadPath}\0`);
    const { githubSync } = loadGithubSync({
        repoRoot: fixture.repoRoot,
        fsAdapter: fs,
        gitCommand
    });

    await githubSync.downloadBackupsFromGitHub(fixture.repoRoot);

    const rewritten = JSON.parse(await fs.promises.readFile(fixture.metadataPath, 'utf8'));
    assert.equal(rewritten.provenance, 'external');
});

test('download audits tracked backup provenance when the repository is already up to date', async (context) => {
    const fixture = await createBackupMetadataFixture(context);
    const revision = '3'.repeat(40);
    const metadataGitPath = `${fixture.wikiId}/${fixture.backupDate}/backup_info.json`;
    const gitCommand = createPullGitCommand('', {
        oldRevision: revision,
        newRevision: revision,
        trackedPathOutput: `${metadataGitPath}\0`
    });
    const { githubSync } = loadGithubSync({
        repoRoot: fixture.repoRoot,
        fsAdapter: fs,
        gitCommand
    });

    await githubSync.downloadBackupsFromGitHub(fixture.repoRoot);

    const rewritten = JSON.parse(await fs.promises.readFile(fixture.metadataPath, 'utf8'));
    assert.equal(rewritten.provenance, 'external');
});

test('an illegal remotely changed metadata path aborts upload before prune, stage, or push', async () => {
    const events = [];
    const gitCommand = createPullGitCommand('1234/2026-08-29_12-30/nested/backup_info.json\0');
    const { githubSync, calls } = loadGithubSync({
        gitCommand,
        onPrune: async () => events.push('prune')
    });

    await assert.rejects(
        githubSync.uploadBackupsToGitHub(REPO_ROOT),
        /backup metadata outside <wiki>\/<date>/
    );
    assert.deepEqual(events, []);
    assert.equal(calls.some(({ args }) => args.includes('add')), false);
    assert.equal(calls.some(({ args }) => args.includes('push')), false);
});

test('invalid remotely changed metadata aborts download before retention', async (context) => {
    const fixture = await createBackupMetadataFixture(context, { backup_paths: 'invalid' });
    const events = [];
    const gitCommand = createPullGitCommand(`${fixture.wikiId}/${fixture.backupDate}/backup_info.json\0`);
    const { githubSync } = loadGithubSync({
        repoRoot: fixture.repoRoot,
        fsAdapter: fs,
        gitCommand,
        onPrune: async () => events.push('prune')
    });

    await assert.rejects(githubSync.downloadBackupsFromGitHub(fixture.repoRoot), /Invalid backup path list/);
    assert.deepEqual(events, []);
    const unchanged = JSON.parse(await fs.promises.readFile(fixture.metadataPath, 'utf8'));
    assert.equal(unchanged.provenance, 'local');
});

test('a truncated non-NUL Git path list fails closed before retention', async () => {
    const events = [];
    const gitCommand = createPullGitCommand('1234/2026-08-29_12-30/backup_info.json');
    const { githubSync } = loadGithubSync({
        gitCommand,
        onPrune: async () => events.push('prune')
    });

    await assert.rejects(githubSync.downloadBackupsFromGitHub(REPO_ROOT), /malformed NUL-delimited path list/);
    assert.deepEqual(events, []);
});
