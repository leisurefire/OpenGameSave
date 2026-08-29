const packageMetadata = require('../package.json');

const updateChannel = String(process.env.UPDATE_CHANNEL || '').trim().toLowerCase();
const publisherName = String(process.env.WIN_PUBLISHER_NAME || '').trim();
const signingCertificate = String(process.env.CSC_LINK || '').trim();

if (!/^(?:latest|[a-z][a-z0-9-]{0,31})$/.test(updateChannel)) {
    throw new Error('UPDATE_CHANNEL must be latest or a lowercase prerelease channel');
}
if (!publisherName || /[\r\n]/.test(publisherName)) {
    throw new Error('WIN_PUBLISHER_NAME must contain the expected Windows certificate subject');
}
if (!signingCertificate) {
    throw new Error('CSC_LINK must contain the Windows code-signing certificate');
}

module.exports = {
    ...packageMetadata.build,
    generateUpdatesFilesForAllChannels: false,
    // Native modules are rebuilt and ABI-verified before signing credentials are
    // exposed to electron-builder in the release workflow.
    npmRebuild: false,
    win: {
        ...(packageMetadata.build.win || {}),
        signtoolOptions: {
            ...(packageMetadata.build.win?.signtoolOptions || {}),
            publisherName: [publisherName]
        }
    },
    publish: {
        ...packageMetadata.build.publish,
        channel: updateChannel
    }
};
