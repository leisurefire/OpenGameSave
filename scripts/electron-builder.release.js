const packageMetadata = require('../package.json');

const updateChannel = String(process.env.UPDATE_CHANNEL || '').trim().toLowerCase();

if (!/^(?:latest|[a-z][a-z0-9-]{0,31})$/.test(updateChannel)) {
    throw new Error('UPDATE_CHANNEL must be latest or a lowercase prerelease channel');
}

module.exports = {
    ...packageMetadata.build,
    generateUpdatesFilesForAllChannels: false,
    publish: {
        ...packageMetadata.build.publish,
        channel: updateChannel
    }
};
