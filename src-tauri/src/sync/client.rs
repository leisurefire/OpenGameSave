use super::{
    credentials::Config,
    manifest::{SyncFile, MAX_MANIFEST},
    util::{self, err, Result},
};
use reqwest::{
    blocking::{Body, Client, Response},
    header::{
        HeaderMap, AUTHORIZATION, CONTENT_LENGTH, ETAG, IF_MATCH, IF_NONE_MATCH, WWW_AUTHENTICATE,
    },
    Method, StatusCode,
};
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
    sync::Mutex,
    time::{Duration, Instant},
};
use uuid::Uuid;

const PROBE_TTL: Duration = Duration::from_secs(300);
static PROBES: Mutex<Vec<(String, Instant)>> = Mutex::new(Vec::new());

#[derive(Clone, Copy)]
pub enum Source<'a> {
    Bytes(&'a [u8]),
    File(&'a Path, u64),
}
impl Source<'_> {
    fn body(self) -> Result<Body> {
        Ok(match self {
            Self::Bytes(bytes) => Body::from(bytes.to_vec()),
            Self::File(path, size) => {
                util::no_links(path)?;
                let file = File::open(path).map_err(err)?;
                if !file.metadata().map_err(err)?.is_file()
                    || file.metadata().map_err(err)?.len() != size
                {
                    return Err("Upload source changed".into());
                }
                Body::sized(file, size)
            }
        })
    }
}
pub struct Dav {
    client: Client,
    pub config: Config,
    collections: RefCell<BTreeSet<String>>,
}
fn http_error(status: StatusCode) -> String {
    if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
        "WebDAV authentication failed".into()
    } else {
        format!("WebDAV request failed (HTTP {})", status.as_u16())
    }
}
pub fn strong_etag(response: &Response) -> Result<String> {
    let value = response
        .headers()
        .get(ETAG)
        .and_then(|v| v.to_str().ok())
        .ok_or("WebDAV server omitted the ETag required for safe synchronization")?;
    validate_etag(value)?;
    Ok(value.into())
}
pub fn validate_etag(value: &str) -> Result<()> {
    if value.len() < 2
        || value.len() > 2048
        || !value.starts_with('"')
        || !value.ends_with('"')
        || value[1..value.len() - 1]
            .bytes()
            .any(|b| b == b'"' || b < 0x21 || b == 0x7f)
    {
        return Err("WebDAV requires one strong ETag for conditional writes".into());
    }
    Ok(())
}
impl Dav {
    pub fn new(config: Config) -> Result<Self> {
        super::credentials::normalize_url(&config.url)?;
        Self::build(config)
    }
    fn build(config: Config) -> Result<Self> {
        let builder = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(30))
            .timeout(Duration::from_secs(600))
            .user_agent("OpenGameSave-Tauri/1");
        // In-process fixtures must bypass the host's optional HTTP/system proxy.
        #[cfg(test)]
        let builder = builder.no_proxy();
        let client = builder
            .build()
            .map_err(|_| "Unable to initialize secure WebDAV transport".to_owned())?;
        Ok(Self {
            client,
            config,
            collections: RefCell::new(BTreeSet::new()),
        })
    }
    #[cfg(test)]
    pub fn test_client(config: Config) -> Self {
        Self::build(config).unwrap()
    }
    pub fn url(&self, path: &str) -> Result<url::Url> {
        if !path.starts_with('/')
            || path.split('/').any(|p| matches!(p, "." | ".."))
            || path.chars().any(|c| c < ' ')
        {
            return Err("Invalid remote resource path".into());
        }
        let mut url = url::Url::parse(&self.config.url).map_err(err)?;
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| "Invalid WebDAV endpoint".to_owned())?;
            segments.pop_if_empty();
            for segment in path.split('/').filter(|s| !s.is_empty()) {
                segments.push(segment);
            }
        }
        Ok(url)
    }
    pub fn request(
        &self,
        method: &str,
        path: &str,
        headers: HeaderMap,
        source: Option<Source<'_>>,
    ) -> Result<Response> {
        let mut url = self.url(path)?;
        let method = Method::from_bytes(method.as_bytes()).map_err(err)?;
        let mut digest_header: Option<String> = None;
        let mut attempts = 0;
        let mut redirects = 0;
        loop {
            let mut request = self
                .client
                .request(method.clone(), url.clone())
                .headers(headers.clone());
            if source.is_none() && method != Method::GET {
                request = request.timeout(Duration::from_secs(30));
            }
            if !self.config.username.is_empty() {
                request = if let Some(auth) = &digest_header {
                    request.header(AUTHORIZATION, auth)
                } else {
                    request.basic_auth(&self.config.username, Some(&self.config.password))
                };
            }
            if let Some(source) = source {
                request = request.body(source.body()?);
            }
            let response = match request.send() {
                Ok(response) => response,
                Err(_) if attempts < 2 && (method == Method::GET || method == Method::HEAD) => {
                    attempts += 1;
                    std::thread::sleep(Duration::from_millis(250 * (1 << attempts)));
                    continue;
                }
                Err(error) => {
                    #[cfg(test)]
                    eprintln!("WebDAV {method} {path}: {error:?}");
                    let _ = error;
                    return Err("WebDAV connection failed or timed out".into());
                }
            };
            if response.status().is_redirection() {
                if source.is_some() {
                    return Err(
                        "WebDAV redirected a request body that cannot be replayed safely".into(),
                    );
                }
                if redirects >= 5 {
                    return Err("WebDAV returned too many redirects".into());
                }
                let next = url
                    .join(
                        response
                            .headers()
                            .get("location")
                            .and_then(|h| h.to_str().ok())
                            .ok_or("Invalid WebDAV redirect")?,
                    )
                    .map_err(err)?;
                if next.origin() != url.origin()
                    || next.scheme() != url.scheme()
                    || !next.username().is_empty()
                    || next.password().is_some()
                {
                    return Err(
                        "WebDAV refused a cross-origin or protocol-changing redirect".into(),
                    );
                }
                url = next;
                redirects += 1;
                digest_header = None;
                continue;
            }
            if response.status() == StatusCode::UNAUTHORIZED
                && digest_header.is_none()
                && !self.config.username.is_empty()
            {
                let challenge = response
                    .headers()
                    .get_all(WWW_AUTHENTICATE)
                    .iter()
                    .filter_map(|v| v.to_str().ok())
                    .find(|s| s.to_ascii_lowercase().starts_with("digest "));
                if let Some(challenge) = challenge {
                    let mut prompt = digest_auth::parse(challenge)
                        .map_err(|_| "Invalid WebDAV Digest authentication challenge".to_owned())?;
                    // auth-int requires materializing arbitrary backup payloads; select auth when offered.
                    if let Some(qop) = &mut prompt.qop {
                        if qop.contains(&digest_auth::Qop::AUTH) {
                            qop.retain(|q| *q == digest_auth::Qop::AUTH);
                        } else if source.is_some() {
                            return Err("WebDAV Digest server requires auth-int; enable qop=auth for streamed backup uploads".into());
                        }
                    }
                    let context = digest_auth::AuthContext::new_with_method(
                        &self.config.username,
                        &self.config.password,
                        url.path(),
                        None::<&[u8]>,
                        digest_auth::HttpMethod::from(method.as_str()),
                    );
                    digest_header = Some(
                        prompt
                            .respond(&context)
                            .map_err(|_| "WebDAV Digest authentication failed".to_owned())?
                            .to_string(),
                    );
                    continue;
                }
            }
            if matches!(
                response.status().as_u16(),
                408 | 425 | 429 | 500 | 502 | 503 | 504
            ) && attempts < 2
                && (method == Method::GET || method == Method::HEAD)
            {
                attempts += 1;
                std::thread::sleep(Duration::from_millis(250 * (1 << attempts)));
                continue;
            }
            return Ok(response);
        }
    }
    pub fn read(
        &self,
        path: &str,
        limit: u64,
        optional: bool,
    ) -> Result<Option<(Vec<u8>, String)>> {
        let mut response = self.request("GET", path, HeaderMap::new(), None)?;
        if optional && response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(http_error(response.status()));
        }
        if response
            .content_length()
            .is_some_and(|length| length > limit)
        {
            return Err("WebDAV response exceeds size limit".into());
        }
        let etag = response
            .headers()
            .get(ETAG)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned();
        let mut bytes = Vec::new();
        response
            .by_ref()
            .take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "WebDAV download failed".to_owned())?;
        if bytes.len() as u64 > limit {
            return Err("WebDAV response exceeds size limit".into());
        }
        Ok(Some((bytes, etag)))
    }
    pub fn json(
        &self,
        path: &str,
        limit: u64,
        optional: bool,
    ) -> Result<Option<(serde_json::Value, String)>> {
        self.read(path, limit, optional)?
            .map(|(bytes, etag)| {
                Ok((
                    serde_json::from_slice(&bytes)
                        .map_err(|_| "Invalid JSON in WebDAV resource".to_owned())?,
                    etag,
                ))
            })
            .transpose()
    }
    pub fn mkdir(&self, path: &str) -> Result<()> {
        let mut current = String::new();
        for segment in path.split('/').filter(|s| !s.is_empty()) {
            current.push('/');
            current.push_str(segment);
            // A transport belongs to one operation. Do not repeat collection
            // discovery for every content object uploaded during that operation.
            if self.collections.borrow().contains(&current) {
                continue;
            }
            let response = self.request("MKCOL", &current, HeaderMap::new(), None)?;
            if response.status() == StatusCode::METHOD_NOT_ALLOWED {
                let mut headers = HeaderMap::new();
                headers.insert("depth", "0".parse().unwrap());
                let prop = self.request("PROPFIND", &current, headers, None)?;
                if !prop.status().is_success() {
                    return Err(http_error(prop.status()));
                }
                let mut data = String::new();
                prop.take(128 * 1024 + 1)
                    .read_to_string(&mut data)
                    .map_err(err)?;
                if data.len() > 128 * 1024 || !data.to_ascii_lowercase().contains("collection") {
                    return Err("WebDAV path is not a collection".into());
                }
            } else if !response.status().is_success() {
                return Err(http_error(response.status()));
            }
            self.collections.borrow_mut().insert(current.clone());
        }
        Ok(())
    }
    pub fn delete(&self, path: &str) -> Result<()> {
        let response = self.request("DELETE", path, HeaderMap::new(), None)?;
        if !response.status().is_success() && response.status() != StatusCode::NOT_FOUND {
            return Err(http_error(response.status()));
        }
        let path = path.trim_end_matches('/');
        let prefix = format!("{path}/");
        self.collections
            .borrow_mut()
            .retain(|entry| entry != path && !entry.starts_with(&prefix));
        Ok(())
    }
    pub fn put(&self, path: &str, source: Source<'_>, etag: Option<&str>) -> Result<bool> {
        let mut headers = HeaderMap::new();
        if let Some(etag) = etag {
            headers.insert(IF_MATCH, etag.parse().map_err(err)?);
        } else {
            headers.insert(IF_NONE_MATCH, "*".parse().unwrap());
        }
        let response = self.request("PUT", path, headers, Some(source))?;
        if response.status() == StatusCode::PRECONDITION_FAILED {
            return Ok(false);
        }
        if !response.status().is_success() {
            return Err(http_error(response.status()));
        }
        Ok(true)
    }
    pub fn verify(
        &self,
        path: &str,
        size: u64,
        sha256: &str,
        destination: Option<&Path>,
    ) -> Result<()> {
        let mut response = self.request("GET", path, HeaderMap::new(), None)?;
        if !response.status().is_success() {
            return Err(http_error(response.status()));
        }
        if response
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|h| h.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .is_some_and(|n| n != size)
        {
            return Err("WebDAV object has incorrect Content-Length".into());
        }
        let mut output = if let Some(path) = destination {
            util::no_links(path)?;
            fs::create_dir_all(path.parent().ok_or("Missing staged parent")?).map_err(err)?;
            Some(
                OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(path)
                    .map_err(err)?,
            )
        } else {
            None
        };
        let mut actual = 0u64;
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let n = response
                .read(&mut buffer)
                .map_err(|_| "WebDAV object download failed or timed out".to_owned())?;
            if n == 0 {
                break;
            }
            actual += n as u64;
            if actual > size {
                return Err("WebDAV object exceeded declared size".into());
            }
            hash.update(&buffer[..n]);
            if let Some(output) = &mut output {
                output.write_all(&buffer[..n]).map_err(err)?;
            }
        }
        if actual != size || format!("{:x}", hash.finalize()) != sha256 {
            return Err("WebDAV object failed SHA-256 verification".into());
        }
        if let Some(output) = output {
            output.sync_all().map_err(err)?;
        }
        Ok(())
    }
    pub fn ensure_object(&self, file: &SyncFile) -> Result<bool> {
        let path = self.object(&file.sha256);
        self.mkdir(path.rsplit_once('/').unwrap().0)?;
        let source = if let Some(data) = &file.data {
            if data.len() as u64 != file.size || util::hash(data) != file.sha256 {
                return Err("Upload source failed integrity verification".into());
            }
            Source::Bytes(data)
        } else {
            let path = file.local_path.as_deref().ok_or("Missing upload source")?;
            if util::hash_file(path)? != (file.size, file.sha256.clone()) {
                return Err("Upload source changed while synchronization was prepared".into());
            }
            Source::File(path, file.size)
        };
        let created = self.put(&path, source, None)?;
        if let Err(error) = self.verify(&path, file.size, &file.sha256, None) {
            if !error.contains("verification")
                && !error.contains("Content-Length")
                && !error.contains("declared size")
                && !error.contains("HTTP 404")
            {
                return Err(error);
            }
            // Conditional repair preserves another client's concurrent upload.
            // Recheck the source before replacing any corrupt object.
            if let Some(data) = &file.data {
                if data.len() as u64 != file.size || util::hash(data) != file.sha256 {
                    return Err("Upload repair source changed".into());
                }
            } else if util::hash_file(file.local_path.as_deref().ok_or("Missing repair source")?)?
                != (file.size, file.sha256.clone())
            {
                return Err("Upload repair source changed".into());
            }
            let response = self.request("GET", &path, HeaderMap::new(), None)?;
            let current_etag = if response.status() == StatusCode::NOT_FOUND {
                None
            } else {
                if !response.status().is_success() {
                    return Err(http_error(response.status()));
                }
                Some(strong_etag(&response)?)
            };
            drop(response);
            let repaired = self.put(&path, source, current_etag.as_deref())?;
            self.verify(&path, file.size, &file.sha256, None)?;
            return Ok(created || repaired);
        }
        Ok(created)
    }
    pub fn object(&self, digest: &str) -> String {
        format!(
            "{}/objects/{}/{}",
            self.config.remote_path,
            &digest[..2],
            digest
        )
    }
    pub fn probe(&self) -> Result<()> {
        // Cache successful capability tests, not current snapshots or contents.
        // Every real write still uses fresh ETags and every object is verified.
        // Include credentials so changing accounts never reuses another account's
        // permissions. Store only the hash, and never persist it on disk.
        let key = util::hash(
            &serde_json::to_vec(&[
                &self.config.url,
                &self.config.username,
                &self.config.password,
                &self.config.remote_path,
            ])
            .map_err(err)?,
        );
        {
            let mut probes = PROBES.lock().map_err(err)?;
            probes.retain(|(_, checked)| checked.elapsed() < PROBE_TTL);
            if probes.iter().any(|(entry, _)| *entry == key) {
                return Ok(());
            }
        }
        self.probe_uncached()?;
        let mut probes = PROBES.lock().map_err(err)?;
        probes.retain(|(entry, checked)| *entry != key && checked.elapsed() < PROBE_TTL);
        if probes.len() >= 32 {
            probes.remove(0);
        }
        probes.push((key, Instant::now()));
        Ok(())
    }
    fn probe_uncached(&self) -> Result<()> {
        self.mkdir(&self.config.remote_path)?;
        let options = self.request("OPTIONS", &self.config.remote_path, HeaderMap::new(), None)?;
        if !options.status().is_success() {
            return Err(http_error(options.status()));
        }
        let root = format!(
            "{}/.opengamesave-capability-{}",
            self.config.remote_path,
            Uuid::new_v4()
        );
        self.mkdir(&root)?;
        let result = (|| {
            let path = format!("{root}/probe.bin");
            let first = b"OpenGameSave conditional probe";
            let second = b"OpenGameSave conditional update";
            if !self.put(&path, Source::Bytes(first), None)? {
                return Err("WebDAV failed conditional create".into());
            }
            if self.put(&path, Source::Bytes(second), None)? {
                return Err("WebDAV ignores If-None-Match; synchronization is unsafe".into());
            }
            self.verify(&path, first.len() as u64, &util::hash(first), None)?;
            let response = self.request("GET", &path, HeaderMap::new(), None)?;
            let etag = strong_etag(&response)?;
            drop(response);
            if self.put(
                &path,
                Source::Bytes(second),
                Some("\"opengamesave-invalid-etag\""),
            )? {
                return Err("WebDAV ignores If-Match; synchronization is unsafe".into());
            }
            if !self.put(&path, Source::Bytes(second), Some(&etag))? {
                return Err("WebDAV failed conditional update".into());
            }
            self.verify(&path, second.len() as u64, &util::hash(second), None)?;
            let moved = format!("{root}/moved.bin");
            let mut headers = HeaderMap::new();
            headers.insert(
                "destination",
                self.url(&moved)?.as_str().parse().map_err(err)?,
            );
            headers.insert("overwrite", "F".parse().unwrap());
            let response = self.request("MOVE", &path, headers, None)?;
            if !response.status().is_success() {
                return Err("WebDAV server does not support safe MOVE".into());
            }
            self.verify(&moved, second.len() as u64, &util::hash(second), None)?;
            self.delete(&moved)?;
            if self.read(&moved, MAX_MANIFEST, true)?.is_some() {
                return Err("WebDAV server failed DELETE verification".into());
            }
            Ok(())
        })();
        let _ = self.delete(&root);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::test_server::Server;
    #[test]
    fn collection_checks_are_shared_by_uploads_and_invalidated_after_delete() {
        let server = Server::start();
        let dav = Dav::test_client(server.config());
        let parent = format!("{}/objects", dav.config.remote_path);
        let first = format!("{parent}/aa");
        dav.mkdir(&first).unwrap();
        let before = server.storage.lock().unwrap().requests.len();
        dav.mkdir(&first).unwrap();
        assert_eq!(server.storage.lock().unwrap().requests.len(), before);
        dav.mkdir(&format!("{parent}/bb")).unwrap();
        assert_eq!(server.storage.lock().unwrap().requests.len(), before + 1);
        dav.delete(&parent).unwrap();
        dav.mkdir(&first).unwrap();
        let storage = server.storage.lock().unwrap();
        assert_eq!(
            storage
                .requests
                .iter()
                .filter(|(method, path, _)| method == "MKCOL" && path == &first)
                .count(),
            2
        );
        assert_eq!(
            storage
                .requests
                .iter()
                .filter(|(method, path, _)| method == "MKCOL" && path == &dav.config.remote_path)
                .count(),
            1
        );
    }
    #[test]
    fn successful_probe_is_cached_by_credentials_and_expires() {
        let server = Server::start();
        let config = server.config();
        Dav::test_client(config.clone()).probe().unwrap();
        let before = server.storage.lock().unwrap().requests.len();
        assert!(before > 10);
        Dav::test_client(config.clone()).probe().unwrap();
        assert_eq!(server.storage.lock().unwrap().requests.len(), before);
        let changed = Config {
            username: "new-user".into(),
            password: "new-password".into(),
            ..config.clone()
        };
        Dav::test_client(changed).probe().unwrap();
        let after_change = server.storage.lock().unwrap().requests.len();
        assert!(after_change > before + 10);
        let key = util::hash(
            &serde_json::to_vec(&[
                &config.url,
                &config.username,
                &config.password,
                &config.remote_path,
            ])
            .unwrap(),
        );
        PROBES
            .lock()
            .unwrap()
            .iter_mut()
            .find(|(entry, _)| *entry == key)
            .unwrap()
            .1 = Instant::now() - PROBE_TTL;
        Dav::test_client(config).probe().unwrap();
        assert!(server.storage.lock().unwrap().requests.len() > after_change + 10);
    }
    #[test]
    fn remote_segments_are_encoded_once() {
        let config = Config {
            url: "https://example.com/dav".into(),
            username: "".into(),
            password: "".into(),
            remote_path: "/OGS".into(),
            device_id: Uuid::new_v4().to_string(),
            has_password: false,
            needs_password: false,
        };
        let dav = Dav::new(config).unwrap();
        assert_eq!(
            dav.url("/OGS/a%2fb #?").unwrap().as_str(),
            "https://example.com/dav/OGS/a%252fb%20%23%3F"
        );
    }
}
