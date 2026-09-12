const policy = require('./ipc-policy.json');

const ROLE_FILES = Object.freeze(policy.files);
const ROLE_CAPABILITIES = Object.freeze(Object.fromEntries(Object.entries(policy.roles).map(([role, capabilities]) => [
    role, Object.freeze(Object.fromEntries(Object.entries(capabilities).map(([direction, channels]) => [direction, Object.freeze(channels)])))
])));
const EMPTY_CAPABILITIES = Object.freeze({ send: Object.freeze([]), invoke: Object.freeze([]), receive: Object.freeze([]) });

function getRoleCapabilities(role) {
    return Object.prototype.hasOwnProperty.call(ROLE_CAPABILITIES, role) ? ROLE_CAPABILITIES[role] : EMPTY_CAPABILITIES;
}

function isRoleAllowed(role, direction, channel) {
    const channels = getRoleCapabilities(role)[direction];
    return Array.isArray(channels) && channels.includes(channel);
}

module.exports = { ROLE_FILES, ROLE_CAPABILITIES, getRoleCapabilities, isRoleAllowed };
