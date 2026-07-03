const sqlite3 = require('sqlite3');

function dbRun(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            err ? reject(err) : resolve(this);
        });
    });
}

function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });
}

function dbGet(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
    });
}

function openDb(dbPath, mode) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, mode, (err) => {
            err ? reject(err) : resolve(db);
        });
    });
}

function closeDb(db) {
    return new Promise((resolve, reject) => {
        db.close((err) => err ? reject(err) : resolve());
    });
}

function stmtAll(stmt, param) {
    return new Promise((resolve, reject) => {
        stmt.all(param, (err, rows) => err ? reject(err) : resolve(rows));
    });
}

function finalizeStmt(stmt) {
    return new Promise((resolve, reject) => {
        stmt.finalize((err) => err ? reject(err) : resolve());
    });
}

module.exports = {
    sqlite3,
    dbRun,
    dbAll,
    dbGet,
    openDb,
    closeDb,
    stmtAll,
    finalizeStmt
};
