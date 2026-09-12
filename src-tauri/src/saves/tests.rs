use super::{archive, backup, database, fs, metadata, resolver, restore, update};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{
    fs as disk,
    path::{Path, PathBuf},
};

struct Fixture {
    temp: tempfile::TempDir,
    db: PathBuf,
    settings: Value,
    game: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("catalog.db");
        let installs = temp.path().join("installs");
        let game = installs.join("Example");
        fs::mkdir(&game.join("saves")).unwrap();
        let settings = json!({"backupPath":temp.path().join("backups"),"gameInstalls":[installs],"saveUninstalledGames":true,"uninstalledGames":[],"backupAllAccounts":false,"maxBackups":1,"language":"en_US"});
        let connection = Connection::open(&db).unwrap();
        connection.execute_batch("CREATE TABLE games(wiki_page_id INTEGER PRIMARY KEY,title TEXT,zh_CN TEXT,install_folder TEXT,steam_id INTEGER,gog_id INTEGER,platform TEXT,save_location TEXT);CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);PRAGMA user_version=1;").unwrap();
        let saves = json!({resolver::platform_key():["{{p|game}}/saves"]});
        connection.execute("INSERT INTO games(wiki_page_id,title,install_folder,platform,save_location)VALUES(42,'Example','Example','[]',?)",[saves.to_string()]).unwrap();
        Self {
            temp,
            db,
            settings,
            game,
        }
    }
    fn root(&self) -> PathBuf {
        metadata::root(&self.settings).unwrap()
    }
}

#[test]
fn full_catalog_scan_reuses_io_without_skipping_uninstalled_rules() {
    let f = Fixture::new();
    let shared = f.temp.path().join("shared-save-data");
    fs::mkdir(&shared).unwrap();
    for index in 0..96 {
        disk::write(shared.join(format!("slot-{index}.sav")), [index as u8; 16]).unwrap();
    }
    disk::write(shared.join("empty.sav"), b"").unwrap();
    let c = Connection::open(&f.db).unwrap();
    for index in 0..12 {
        let unique = f.temp.path().join(format!("game-{index}.dat"));
        disk::write(&unique, format!("unique save {index}")).unwrap();
        let template = json!({resolver::platform_key():[
            shared,
            format!("{}/missing-{index}*.sav", shared.to_string_lossy().replace('\\', "/")),
            unique
        ]});
        c.execute("INSERT INTO games(wiki_page_id,title,install_folder,platform,save_location)VALUES(?,'Uninstalled fixture','Not installed','[]',?)", params![100+index, template.to_string()]).unwrap();
    }
    drop(c);
    let mut baseline = fs::ScanContext::uncached();
    let expected = database::scan_with_context(
        &f.settings,
        &f.db,
        &json!({}),
        (None, true, false),
        |_| {},
        &mut baseline,
    )
    .unwrap();
    let mut cached = fs::ScanContext::default();
    let actual = database::scan_with_context(
        &f.settings,
        &f.db,
        &json!({}),
        (None, true, false),
        |_| {},
        &mut cached,
    )
    .unwrap();
    assert_eq!(actual, expected);
    assert_eq!(actual["games"].as_array().unwrap().len(), 12);
    for game in actual["games"].as_array().unwrap() {
        assert_eq!(game["resolved_paths"].as_array().unwrap().len(), 2);
    }
    assert!(
        cached.metrics.directory_reads * 3 < baseline.metrics.directory_reads,
        "cached={:?}, baseline={:?}",
        cached.metrics,
        baseline.metrics
    );
    assert!(
        cached.metrics.strict_path_checks * 4 < baseline.metrics.strict_path_checks,
        "cached={:?}, baseline={:?}",
        cached.metrics,
        baseline.metrics
    );
    assert!(cached.metrics.pattern_hits >= 11);
    assert!(cached.metrics.stats_hits >= 11);
    assert!(cached.metrics.directory_hits > 0);
    eprintln!(
        "Full scan I/O: cached={:?}; uncached={:?}",
        cached.metrics, baseline.metrics
    );
}

#[test]
fn scan_cache_is_ephemeral_and_backup_reads_current_files() {
    let f = Fixture::new();
    let save = f.game.join("saves/slot.sav");
    disk::write(&save, "old").unwrap();
    let mut scan = fs::ScanContext::default();
    let before = database::scan_with_context(
        &f.settings,
        &f.db,
        &json!({}),
        (None, true, false),
        |_| {},
        &mut scan,
    )
    .unwrap();
    assert_eq!(before["games"][0]["backup_size"], 3);
    disk::write(&save, "changed after scan").unwrap();
    let snapshot = backup::create(&f.settings, &f.db, &json!({}), "42").unwrap();
    assert_eq!(
        disk::read_to_string(f.root().join("42").join(snapshot).join("path1/slot.sav")).unwrap(),
        "changed after scan"
    );
    let after =
        database::scan_with_data(&f.settings, &f.db, &json!({}), None, false, false, |_| {})
            .unwrap();
    assert_eq!(after["games"][0]["backup_size"], 18);
}

#[test]
fn scan_cancellation_stops_before_the_next_catalog_row() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    let f = Fixture::new();
    disk::write(f.game.join("saves/slot.sav"), "original").unwrap();
    let c = Connection::open(&f.db).unwrap();
    c.execute("INSERT INTO games SELECT 43,'Second',zh_CN,install_folder,steam_id,gog_id,platform,save_location FROM games WHERE wiki_page_id=42", []).unwrap();
    drop(c);
    let cancelled = Arc::new(AtomicBool::new(false));
    let mut scan = fs::ScanContext::with_cancellation(cancelled.clone());
    let error = database::scan_with_context(
        &f.settings,
        &f.db,
        &json!({}),
        (None, true, false),
        |_| {
            cancelled.store(true, Ordering::Relaxed);
        },
        &mut scan,
    )
    .unwrap_err();
    assert_eq!(error, "Save scan cancelled");
    assert_eq!(
        disk::read_to_string(f.game.join("saves/slot.sav")).unwrap(),
        "original"
    );
    assert!(scan.stats(&f.game).is_err());
}

#[test]
fn scanning_rechecks_live_ancestors_before_enumerating_an_uncached_directory() {
    let temp = tempfile::tempdir().unwrap();
    let original = temp.path().join("original");
    let parked = temp.path().join("parked");
    let external = temp.path().join("external");
    fs::mkdir(&original).unwrap();
    fs::mkdir(&external).unwrap();
    disk::write(external.join("outside.sav"), "outside").unwrap();
    let mut scan = fs::ScanContext::default();
    assert!(scan.regular(&original).unwrap().is_dir());
    disk::rename(&original, &parked).unwrap();
    #[cfg(windows)]
    if std::os::windows::fs::symlink_dir(&external, &original).is_err() {
        disk::rename(&parked, &original).unwrap();
        return; // Creating symlinks needs Developer Mode or a privileged test host.
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(&external, &original).unwrap();
    assert!(scan.read_dir(&original).is_err());
    assert_eq!(scan.metrics.directory_reads, 0);
    assert!(fs::regular(&original).is_err());
}

#[test]
fn mixed_sqlite_platform_ids_do_not_abort_the_catalog_scan() {
    let f = Fixture::new();
    disk::write(f.game.join("saves/slot.sav"), "save").unwrap();
    let c = Connection::open(&f.db).unwrap();
    c.execute(
        "UPDATE games SET steam_id=123,gog_id='example_game_slug' WHERE wiki_page_id=42",
        [],
    )
    .unwrap();
    c.execute("INSERT INTO games SELECT 43,'Second',NULL,install_folder,'text_platform_id',987,platform,save_location FROM games WHERE wiki_page_id=42", []).unwrap();
    drop(c);
    let scan = database::scan_with_data(&f.settings, &f.db, &json!({}), None, false, false, |_| {})
        .unwrap();
    assert_eq!(scan["errors"], json!([]));
    assert_eq!(scan["games"].as_array().unwrap().len(), 2);
    assert_eq!(scan["games"][0]["steam_id"], 123);
    assert_eq!(scan["games"][0]["gog_id"], "example_game_slug");
    assert_eq!(scan["games"][1]["steam_id"], "text_platform_id");
    assert_eq!(scan["games"][1]["gog_id"], 987);
    assert_eq!(
        database::definition(&f.db, "42", &f.settings).unwrap()["gog_id"],
        "example_game_slug"
    );
}

#[test]
fn bundled_catalog_scans_all_real_rows_and_finds_a_local_fixture() {
    let f = Fixture::new();
    let bundled = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("database/database.db");
    let db = f.temp.path().join("real-catalog.db");
    disk::copy(&bundled, &db).unwrap();
    let c = Connection::open(&db).unwrap();
    c.execute("INSERT INTO games(wiki_page_id,title,install_folder,steam_id,gog_id,platform,save_location) VALUES(999999991,'Rust native scan fixture','Example',123,'fixture_gog_slug','[]',?)", [json!({resolver::platform_key():["{{p|game}}/saves"]}).to_string()]).unwrap();
    drop(c);
    disk::write(f.game.join("saves/empty.sav"), b"").unwrap();
    let scan =
        database::scan_with_data(&f.settings, &db, &json!({}), None, false, false, |_| {}).unwrap();
    let row = scan["games"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["wiki_page_id"] == "999999991")
        .unwrap();
    assert_eq!(row["gog_id"], "fixture_gog_slug");
    assert_eq!(row["backup_size"], 0);
    assert_eq!(row["resolved_paths"][0]["type"], "folder");
}

#[test]
fn empty_file_saves_and_nested_installs_survive_scan_backup_and_restore() {
    let f = Fixture::new();
    let installs = Path::new(f.settings["gameInstalls"][0].as_str().unwrap());
    let nested = installs.join("Nested/Example");
    fs::mkdir(&nested).unwrap();
    let source = nested.join("zero.sav");
    disk::write(&source, b"").unwrap();
    let c = Connection::open(&f.db).unwrap();
    c.execute(
        "UPDATE games SET install_folder='Nested/Example',save_location=? WHERE wiki_page_id=42",
        [json!({resolver::platform_key():["{{p|game}}/zero.sav"]}).to_string()],
    )
    .unwrap();
    drop(c);
    let scan = database::scan_with_data(&f.settings, &f.db, &json!({}), None, false, false, |_| {})
        .unwrap();
    assert_eq!(
        fs::key(Path::new(
            scan["games"][0]["install_path"].as_str().unwrap()
        )),
        fs::key(&nested)
    );
    assert_eq!(scan["games"][0]["resolved_paths"][0]["type"], "file");
    assert_eq!(scan["games"][0]["backup_size"], 0);
    let snapshot = backup::create(&f.settings, &f.db, &json!({}), "42").unwrap();
    disk::write(&source, "changed").unwrap();
    let plan = restore::plan(&f.settings, &f.db, &json!({}), "42", Some(&snapshot)).unwrap();
    restore::execute(&plan, &f.root()).unwrap();
    assert!(disk::read(&source).unwrap().is_empty());
}

#[test]
fn sqlite_scan_backup_restore_retention_and_migration_preserve_actual_saves() {
    let f = Fixture::new();
    let save = f.game.join("saves/slot.sav");
    disk::write(&save, b"original game save").unwrap();
    disk::write(f.game.join("saves/empty.dat"), b"").unwrap();
    let scan = database::scan_with_data(&f.settings, &f.db, &json!({}), None, false, false, |_| {})
        .unwrap();
    assert_eq!(scan["errors"], json!([]));
    assert_eq!(scan["games"][0]["wiki_page_id"], "42");
    assert_eq!(scan["games"][0]["backup_size"], 18);
    let first = backup::create(&f.settings, &f.db, &json!({}), "42").unwrap();
    backup::update(
        &f.root(),
        &json!("42"),
        &first,
        "is_permanent",
        &json!(true),
    )
    .unwrap();
    backup::update(
        &f.root(),
        &json!("42"),
        &first,
        "custom_name",
        &json!("Before changes"),
    )
    .unwrap();
    disk::write(&save, b"new progress").unwrap();
    disk::write(f.game.join("saves/later.sav"), b"new slot").unwrap();
    let second = backup::create(&f.settings, &f.db, &json!({}), "42").unwrap();
    disk::write(&save, b"third progress").unwrap();
    let third = backup::create(&f.settings, &f.db, &json!({}), "42").unwrap();
    assert!(f.root().join("42").join(&first).exists());
    assert!(!f.root().join("42").join(&second).exists());
    assert!(f.root().join("42").join(&third).exists());
    let plan = restore::plan(&f.settings, &f.db, &json!({}), "42", Some(&first)).unwrap();
    restore::execute(&plan, &f.root()).unwrap();
    assert_eq!(disk::read(&save).unwrap(), b"original game save");
    assert!(f.game.join("saves/empty.dat").exists());
    assert!(!f.game.join("saves/later.sav").exists());
    let exported =
        archive::export(&f.root(), &f.temp.path().join("exports"), 1, None, |_| {}).unwrap();
    let imported = f.temp.path().join("imported");
    let results = archive::import(&imported, &exported, |_| {}).unwrap();
    assert_eq!(results["imported"], 2);
    assert_eq!(
        metadata::load(&imported.join("42").join(&first)).unwrap()["custom_name"],
        "Before changes"
    );
    let migrated = f.temp.path().join("migrated");
    let committed = std::cell::Cell::new(false);
    archive::migrate(
        &imported,
        &migrated,
        |_| {},
        || {
            committed.set(true);
            Ok(())
        },
    )
    .unwrap();
    assert!(committed.get());
    assert!(!imported.exists());
    assert!(migrated
        .join("42")
        .join(first)
        .join("path1/empty.dat")
        .exists());
}

#[test]
fn xbox_metadata_candidates_are_scanned_without_full_scan_or_install() {
    let f = Fixture::new();
    let save = f.temp.path().join("xbox-save");
    fs::mkdir(&save).unwrap();
    disk::write(save.join("containers.index"), b"xbox save").unwrap();
    let c = Connection::open(&f.db).unwrap();
    c.execute("INSERT INTO games(wiki_page_id,title,platform,save_location)VALUES(77,'Xbox candidate','[]',?)",[json!({resolver::platform_key():[save]}).to_string()]).unwrap();
    c.execute(
        "INSERT INTO metadata(key,value)VALUES('xgp_save_tools_wiki_ids','[77]')",
        [],
    )
    .unwrap();
    drop(c);
    let scan = database::scan_with_data(&f.settings, &f.db, &json!({}), None, false, true, |_| {})
        .unwrap();
    assert!(scan["games"]
        .as_array()
        .unwrap()
        .iter()
        .any(|g| g["wiki_page_id"] == "77"));
    let one = database::scan_with_data(
        &f.settings,
        &f.db,
        &json!({}),
        Some("77"),
        false,
        true,
        |_| {},
    )
    .unwrap();
    assert_eq!(one["games"][0]["wiki_page_id"], "77");
}

#[test]
fn payload_metadata_cannot_grant_restore_outside_catalog() {
    let f = Fixture::new();
    disk::write(f.game.join("saves/slot.sav"), "safe").unwrap();
    let when = backup::create(&f.settings, &f.db, &json!({}), "42").unwrap();
    let path = f.root().join("42").join(&when);
    let mut metadata = metadata::load(&path).unwrap();
    metadata["backup_paths"][0]["template"] = json!("{{p|game}}/unrelated");
    fs::atomic_json(&path.join("backup_info.json"), &metadata).unwrap();
    assert!(restore::plan(&f.settings, &f.db, &json!({}), "42", Some(&when)).is_err());
}

#[test]
fn source_file_payload_cannot_redirect_its_filename() {
    let f = Fixture::new();
    let c = Connection::open(&f.db).unwrap();
    c.execute(
        "UPDATE games SET save_location=? WHERE wiki_page_id=42",
        [json!({resolver::platform_key():["{{p|game}}/saves/slot.sav"]}).to_string()],
    )
    .unwrap();
    drop(c);
    disk::write(f.game.join("saves/slot.sav"), "safe").unwrap();
    let when = backup::create(&f.settings, &f.db, &json!({}), "42").unwrap();
    let path = f.root().join("42").join(&when).join("path1");
    disk::rename(path.join("slot.sav"), path.join("other.sav")).unwrap();
    assert!(restore::plan(&f.settings, &f.db, &json!({}), "42", Some(&when)).is_err());
}

#[test]
fn xbox_pgs_detection_is_case_insensitive_and_scoped() {
    assert!(resolver::pgs("C:\\XboxGames\\GameSave\\PGS\\game"));
    assert!(resolver::pgs("d:/xboxgames/gamesave/pgs"));
    assert!(!resolver::pgs("C:/XboxGames/GameSave/PGSomething"));
    assert!(!resolver::pgs("C:/Users/Example/XboxGames/GameSave/PGS"));
}

#[test]
#[cfg(windows)]
fn xbox_pgs_restore_is_blocked_before_any_destination_write() {
    let f = Fixture::new();
    let c = Connection::open(&f.db).unwrap();
    c.execute(
        "UPDATE games SET save_location=? WHERE wiki_page_id=42",
        [json!({"win":["C:/XboxGames/GameSave/PGS/TestSave"]}).to_string()],
    )
    .unwrap();
    drop(c);
    let mut settings = f.settings.clone();
    settings["gameInstalls"]
        .as_array_mut()
        .unwrap()
        .push(json!("C:/XboxGames"));
    let snapshot = f.root().join("42/2025-01-01_00-00");
    fs::mkdir(&snapshot.join("path1")).unwrap();
    disk::write(snapshot.join("path1/data"), "PGS").unwrap();
    fs::atomic_json(&snapshot.join("backup_info.json"),&json!({"title":"PGS","provenance":"local","backup_paths":[{"folder_name":"path1","template":"C:/XboxGames/GameSave/PGS/TestSave","type":"folder"}]})).unwrap();
    let error = match restore::plan(&settings, &f.db, &json!({}), "42", None) {
        Ok(_) => panic!("PGS restore must fail"),
        Err(e) => e,
    };
    assert!(error.contains("backup-only"), "{error}");
}

#[test]
fn validates_bundled_database_and_recovers_interrupted_replacement() {
    let bundled = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("database/database.db");
    let validated = update::validate(&bundled, None, None, None).unwrap();
    assert!(validated["version"].as_u64().is_some());
    let temp = tempfile::tempdir().unwrap();
    let db = temp.path().join("catalog.db");
    disk::copy(&bundled, db.with_extension("db.previous")).unwrap();
    update::recover(&db).unwrap();
    assert!(db.exists());
    assert!(!db.with_extension("db.previous").exists());
    assert_eq!(update::validate(&db, None, None, None).unwrap(), validated);
}

#[test]
fn full_scan_discovers_uninstalled_saves_but_respects_platform() {
    let f = Fixture::new();
    let save = f.temp.path().join("uninstalled.sav");
    disk::write(&save, "found").unwrap();
    let c = Connection::open(&f.db).unwrap();
    let other = if resolver::platform_key() == "win" {
        "linux"
    } else {
        "win"
    };
    for (id, locations) in [
        (80, json!({resolver::platform_key():[save]})),
        (81, json!({other:[save]})),
    ] {
        c.execute("INSERT INTO games(wiki_page_id,title,platform,save_location)VALUES(?,'Uninstalled','[]',?)",params![id,locations.to_string()]).unwrap();
    }
    drop(c);
    let normal =
        database::scan_with_data(&f.settings, &f.db, &json!({}), None, false, false, |_| {})
            .unwrap();
    assert!(normal["games"].as_array().unwrap().is_empty());
    let full = database::scan_with_data(&f.settings, &f.db, &json!({}), None, true, false, |_| {})
        .unwrap();
    assert_eq!(full["games"].as_array().unwrap().len(), 1);
    assert_eq!(full["games"][0]["wiki_page_id"], "80");
}

#[test]
fn account_context_overrides_generic_uid_and_wildcards_are_bounded() {
    let temp = tempfile::tempdir().unwrap();
    let steam = temp.path().join("Steam");
    for account in ["76561197960265851", "123"] {
        let dir = steam.join(format!("userdata/{account}/42/remote"));
        fs::mkdir(&dir).unwrap();
        disk::write(dir.join("slot.sav"), account).unwrap();
    }
    let data = json!({"steamPath":steam,"currentSteamUserId64":"76561197960265851","currentSteamUserId3":"123"});
    let one = resolver::Resolver::new(&json!({"backupAllAccounts":false}), &data, None)
        .resolve("{{p|steam}}/userdata/{{p|uid}}/**/remote/*.sav", false)
        .unwrap();
    assert_eq!(one.len(), 1);
    assert!(one[0]["resolved"]
        .as_str()
        .unwrap()
        .replace('\\', "/")
        .contains("/userdata/123/"));
    let all = resolver::Resolver::new(&json!({"backupAllAccounts":true}), &data, None)
        .resolve("{{p|steam}}/userdata/{{p|uid}}/**/remote/*.sav", false)
        .unwrap();
    assert_eq!(all.len(), 2);
}

#[test]
fn recursive_save_globs_do_not_traverse_directory_links() {
    let temp = tempfile::tempdir().unwrap();
    let game = temp.path().join("game");
    let outside = temp.path().join("outside");
    fs::mkdir(&game).unwrap();
    fs::mkdir(&outside).unwrap();
    disk::write(game.join("good.sav"), "safe").unwrap();
    disk::write(outside.join("secret.sav"), "outside").unwrap();
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_dir(&outside, game.join("linked"));
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(&outside, game.join("linked"));
    // Windows machines without Developer Mode may deny creation; the same
    // no-follow traversal is exercised on platforms where links are available.
    if linked.is_err() {
        return;
    }
    let r = resolver::Resolver::new(&json!({}), &json!({}), game.to_str());
    let paths = r.resolve("{{p|game}}/**/*.sav", false).unwrap();
    assert_eq!(paths.len(), 1);
    assert!(paths[0]["resolved"].as_str().unwrap().ends_with("good.sav"));
}

#[test]
fn nested_backup_storage_cannot_be_copied_restored_or_deleted_as_game_data() {
    let f = Fixture::new();
    let saves = f.game.join("saves");
    disk::write(saves.join("slot.sav"), "original").unwrap();
    let mut settings = f.settings.clone();
    let root = saves.join("backups");
    settings["backupPath"] = json!(root);
    let snapshot = root.join("42/2025-01-01_00-00");
    fs::mkdir(&snapshot.join("path1")).unwrap();
    disk::write(snapshot.join("path1/slot.sav"), "old").unwrap();
    fs::atomic_json(&snapshot.join("backup_info.json"),&json!({"title":"Game","provenance":"local","backup_paths":[{"folder_name":"path1","template":"{{p|game}}/saves","type":"folder"}]})).unwrap();
    assert!(backup::create(&settings, &f.db, &json!({}), "42").is_err());
    assert!(restore::plan(&settings, &f.db, &json!({}), "42", None).is_err());
    assert!(restore::delete_local(&settings, &f.db, &json!({}), "42").is_err());
    assert_eq!(
        disk::read_to_string(saves.join("slot.sav")).unwrap(),
        "original"
    );
    assert_eq!(
        disk::read_to_string(snapshot.join("path1/slot.sav")).unwrap(),
        "old"
    );
}

#[test]
fn metadata_text_limits_preserve_legacy_chinese_and_utf16_lengths() {
    let name = "存".repeat(120);
    let info =
        metadata::validate(&json!({"title":"Game","backup_paths":[],"custom_name":name})).unwrap();
    assert_eq!(info["custom_name"], name);
    let emoji = "🎮".repeat(60);
    assert!(
        metadata::validate(&json!({"title":"Game","backup_paths":[],"custom_name":emoji})).is_ok()
    );
    assert!(metadata::validate(
        &json!({"title":"Game","backup_paths":[],"custom_name":"🎮".repeat(61)})
    )
    .is_err());
    for date in [
        "2025-01-01_12-00-60",
        "2025- 1-01_12-00-00",
        "2025-1-01_12-00-00",
    ] {
        assert!(metadata::date(date).is_err(), "{date}");
    }
}
