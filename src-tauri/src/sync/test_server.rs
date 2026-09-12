//! Minimal in-process WebDAV fixture; never contacts a real account or service.
use super::{credentials::Config, util};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
};
use uuid::Uuid;

#[derive(Default)]
pub struct Storage {
    pub files: BTreeMap<String, Vec<u8>>,
    directories: BTreeSet<String>,
    pub fail_pointer_once: bool,
    pub requests: Vec<(String, String, BTreeMap<String, String>)>,
}
pub struct Server {
    pub url: String,
    pub storage: Arc<Mutex<Storage>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Server {
    pub fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let storage = Arc::new(Mutex::new(Storage::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let data = storage.clone();
        let stopping = stop.clone();
        let worker = thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else {
                    break;
                };
                if stopping.load(Ordering::Relaxed) {
                    break;
                }
                let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));
                serve(&mut stream, &data);
            }
        });
        Self {
            url: format!("http://{address}"),
            storage,
            stop,
            worker: Some(worker),
        }
    }
    pub fn config(&self) -> Config {
        Config {
            url: self.url.clone(),
            username: "".into(),
            password: "".into(),
            remote_path: "/OpenGameSave".into(),
            device_id: Uuid::new_v4().to_string(),
            has_password: false,
            needs_password: false,
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect(self.url.trim_start_matches("http://"));
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
fn serve(stream: &mut TcpStream, data: &Mutex<Storage>) {
    let mut header = Vec::new();
    let mut byte = [0u8; 1];
    while !header.ends_with(b"\r\n\r\n") {
        if header.len() > 65536 || stream.read_exact(&mut byte).is_err() {
            return;
        }
        header.push(byte[0]);
    }
    let header = String::from_utf8_lossy(&header);
    let mut lines = header.lines();
    let request = lines
        .next()
        .unwrap_or("")
        .split_whitespace()
        .collect::<Vec<_>>();
    if request.len() < 2 {
        return;
    }
    let method = request[0];
    let path = request[1].to_owned();
    let mut headers = BTreeMap::new();
    for line in lines {
        if let Some((key, value)) = line.split_once(':') {
            headers.insert(key.to_ascii_lowercase(), value.trim().to_owned());
        }
    }
    let length = headers
        .get("content-length")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(0);
    if length > 20 * 1024 * 1024 {
        return;
    }
    let mut payload = vec![0u8; length];
    if stream.read_exact(&mut payload).is_err() {
        return;
    }
    let mut storage = data.lock().unwrap();
    storage
        .requests
        .push((method.into(), path.clone(), headers.clone()));
    let mut status = 200;
    let mut body = Vec::new();
    let mut extra = String::new();
    let etag = |bytes: &[u8]| format!("\"{}\"", util::hash(bytes));
    match method {
        "OPTIONS" => {}
        "MKCOL" => {
            if storage.directories.insert(path.clone()) {
                status = 201;
            } else {
                status = 405;
            }
        }
        "PROPFIND" => {
            if storage.directories.contains(&path) {
                status = 207;
                body = b"<d:multistatus xmlns:d=\"DAV:\"><d:collection/></d:multistatus>".to_vec();
            } else {
                status = 404;
            }
        }
        "GET" => {
            if let Some(bytes) = storage.files.get(&path) {
                body = bytes.clone();
                extra = format!("ETag: {}\r\n", etag(bytes));
            } else {
                status = 404;
            }
        }
        "PUT" => {
            if path.ends_with("/current.json") && storage.fail_pointer_once {
                storage.fail_pointer_once = false;
                status = 412;
            } else if (headers.get("if-none-match").is_some_and(|s| s == "*")
                && storage.files.contains_key(&path))
                || headers.get("if-match").is_some_and(|condition| {
                    storage
                        .files
                        .get(&path)
                        .is_none_or(|bytes| condition != &etag(bytes))
                })
            {
                status = 412;
            } else {
                storage.files.insert(path, payload);
                status = 201;
            }
        }
        "DELETE" => {
            storage
                .files
                .retain(|key, _| key != &path && !key.starts_with(&format!("{path}/")));
            storage
                .directories
                .retain(|key| key != &path && !key.starts_with(&format!("{path}/")));
            status = 204;
        }
        "MOVE" => {
            let destination = headers
                .get("destination")
                .and_then(|s| url::Url::parse(s).ok())
                .map(|u| u.path().to_owned())
                .unwrap_or_default();
            if storage.files.contains_key(&destination) {
                status = 412;
            } else if let Some(bytes) = storage.files.remove(&path) {
                storage.files.insert(destination, bytes);
                status = 201;
            } else {
                status = 404;
            }
        }
        _ => status = 405,
    }
    drop(storage);
    let response = format!(
        "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.write_all(&body);
    let _ = stream.flush();
    // Finish the response with FIN before closing the socket. Windows otherwise
    // occasionally resets a just-written response while the peer is still reading.
    let _ = stream.shutdown(std::net::Shutdown::Write);
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(100)));
    let mut drain = [0u8; 1024];
    while matches!(stream.read(&mut drain),Ok(n) if n>0) {}
}
