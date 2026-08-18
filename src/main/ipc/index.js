const { registerApplicationIpc } = require('./application');
const { registerBackupIpc } = require('./backup');
const { registerDatabaseIpc } = require('./database');
const { registerRestoreIpc } = require('./restore');
const { registerSettingsIpc } = require('./settings');
const { registerWindowIpc } = require('./window');

function registerIpcHandlers(dependencies) {
    registerSettingsIpc(dependencies);
    registerWindowIpc(dependencies);
    registerDatabaseIpc(dependencies);
    registerBackupIpc(dependencies);
    registerRestoreIpc(dependencies);
    registerApplicationIpc();
}

module.exports = { registerIpcHandlers };
