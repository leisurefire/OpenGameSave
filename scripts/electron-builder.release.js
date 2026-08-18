const packageMetadata = require('../package.json');

const publisherName = String(process.env.WINDOWS_PUBLISHER_NAME || '').trim();
const updateChannel = String(process.env.UPDATE_CHANNEL || '').trim().toLowerCase();

if (!publisherName) throw new Error('WINDOWS_PUBLISHER_NAME is required for signed release builds');
if (!/^(?:latest|[a-z][a-z0-9-]{0,31})$/.test(updateChannel)) {
    throw new Error('UPDATE_CHANNEL must be latest or a lowercase prerelease channel');
}

module.exports = {
    ...packageMetadata.build,
    forceCodeSigning: true,
    generateUpdatesFilesForAllChannels: false,
    publish: {
        ...packageMetadata.build.publish,
        channel: updateChannel
    },
    win: {
        ...(packageMetadata.build.win || {}),
        verifyUpdateCodeSignature: true,
        signtoolOptions: {
            publisherName,
            signingHashAlgorithms: ['sha256']
        }
    }
};
