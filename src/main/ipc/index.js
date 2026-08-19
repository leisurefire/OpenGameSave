const { registerApplicationIpc } = require('./application');
const { registerBackupIpc } = require('./backup');
const { registerDatabaseIpc } = require('./database');
const { registerGuideIpc } = require('./guides');
const { registerLibraryIpc } = require('./library');
const { registerRestoreIpc } = require('./restore');
const { registerSettingsIpc } = require('./settings');
const { registerWindowIpc } = require('./window');

function registerIpcHandlers(dependencies) {
    registerSettingsIpc(dependencies);
    registerWindowIpc(dependencies);
    registerDatabaseIpc(dependencies);
    registerGuideIpc(dependencies);
    registerLibraryIpc(dependencies);
    registerBackupIpc(dependencies);
    registerRestoreIpc(dependencies);
    registerApplicationIpc();
}

module.exports = { registerIpcHandlers };
