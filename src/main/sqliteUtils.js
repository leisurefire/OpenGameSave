const Database = require('better-sqlite3');

function bindParams(statement, method, params) {
    if (Array.isArray(params)) {
        return statement[method](...params);
    }
    if (params && typeof params === 'object') {
        return statement[method](params);
    }
    if (params === undefined) {
        return statement[method]();
    }
    return statement[method](params);
}

function dbRun(db, sql, params = []) {
    if (params.length === 0) {
        return db.exec(sql);
    }
    return bindParams(db.prepare(sql), 'run', params);
}

function dbAll(db, sql, params = []) {
    return bindParams(db.prepare(sql), 'all', params);
}

function dbGet(db, sql, params = []) {
    return bindParams(db.prepare(sql), 'get', params);
}

function openDb(dbPath, options = {}) {
    return new Database(dbPath, {
        timeout: 5000,
        ...options
    });
}

function closeDb(db) {
    db.close();
}

function stmtAll(stmt, param) {
    return bindParams(stmt, 'all', param);
}

module.exports = {
    dbRun,
    dbAll,
    dbGet,
    openDb,
    closeDb,
    stmtAll
};
