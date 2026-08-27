use serde_json::{json, Value};
use std::env;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug)]
struct Options {
    runtime: Option<PathBuf>,
    service_project: Option<PathBuf>,
    root: PathBuf,
}

#[derive(Debug)]
struct Runtime {
    _child: Child,
    stream: TcpStream,
    next_id: u64,
}

impl Drop for Runtime {
    fn drop(&mut self) {
        let _ = self._child.kill();
        let _ = self._child.wait();
    }
}

#[derive(Debug)]
enum Resp {
    Simple(String),
    Error(String),
    Integer(i64),
    Bulk(Option<Vec<u8>>),
    Array(Option<Vec<Resp>>),
}

fn executable(path: &Path) -> bool {
    path.is_file()
}

fn parse_options() -> Result<Options, String> {
    let mut runtime = None;
    let mut service_project = None;
    let mut root = env::current_dir().map_err(|error| error.to_string())?;
    let args: Vec<String> = env::args().skip(1).collect();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--stdio" => index += 1,
            "--runtime" => {
                index += 1;
                runtime = Some(PathBuf::from(
                    args.get(index).ok_or("--runtime needs a path")?,
                ));
                index += 1;
            }
            "--service-project" => {
                index += 1;
                service_project = Some(PathBuf::from(
                    args.get(index).ok_or("--service-project needs a path")?,
                ));
                index += 1;
            }
            "--root" => {
                index += 1;
                root = PathBuf::from(args.get(index).ok_or("--root needs a path")?);
                index += 1;
            }
            value if value.starts_with('-') => {
                return Err(format!("unknown option: {value}"));
            }
            _ => index += 1,
        }
    }
    Ok(Options {
        runtime,
        service_project,
        root,
    })
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    env::var_os("PATH").and_then(|paths| {
        env::split_paths(&paths)
            .map(|directory| directory.join(name))
            .find(|candidate| executable(candidate))
    })
}

fn runtime_path(options: &Options) -> Result<PathBuf, String> {
    if let Some(path) = &options.runtime {
        return Ok(path.clone());
    }
    if let Some(path) = env::var_os("HARA_RUNTIME").map(PathBuf::from) {
        if executable(&path) {
            return Ok(path);
        }
    }
    let requested = PathBuf::from("/home/hoebat/.local/bin/hara-rust-lite");
    if executable(&requested) {
        return Ok(requested);
    }
    for name in ["hara-rust-lite", "hara-lite", "hara"] {
        if let Some(path) = find_on_path(name) {
            return Ok(path);
        }
    }
    Err("could not find a Hara runtime; set HARA_RUNTIME or --runtime".into())
}

fn service_project_path(options: &Options) -> Result<PathBuf, String> {
    if let Some(path) = &options.service_project {
        return Ok(path.clone());
    }
    if let Some(path) = env::var_os("HARA_LSP_PROJECT").map(PathBuf::from) {
        if path.join("project.edn").is_file() {
            return Ok(path);
        }
    }
    let candidates = [
        options.root.join("extensions/hara-lsp"),
        options.root.join("hara-lsp"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")),
        PathBuf::from("/home/hoebat/.local/share/hara-lsp"),
    ];
    candidates
        .into_iter()
        .find(|path| path.join("project.edn").is_file())
        .ok_or_else(|| "could not locate the hara-lsp Hara project; set HARA_LSP_PROJECT".into())
}

fn endpoint_from_line(line: &str) -> Option<SocketAddr> {
    let marker = "HARA RESP ";
    let start = line.find(marker)? + marker.len();
    let endpoint = line[start..].split_whitespace().next()?;
    endpoint.parse().ok()
}

fn stdout_endpoint(stdout: impl Read + Send + 'static) -> Receiver<SocketAddr> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().flatten() {
            if let Some(endpoint) = endpoint_from_line(&line) {
                let _ = sender.send(endpoint);
            }
        }
    });
    receiver
}

fn drain_stderr(stderr: impl Read + Send + 'static) {
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            eprintln!("hara runtime: {line}");
        }
    });
}

fn terminate_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn connect_endpoint(endpoint: SocketAddr) -> Result<TcpStream, String> {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match TcpStream::connect_timeout(&endpoint, Duration::from_millis(250)) {
            Ok(stream) => {
                stream
                    .set_read_timeout(Some(Duration::from_secs(30)))
                    .map_err(|error| error.to_string())?;
                stream
                    .set_write_timeout(Some(Duration::from_secs(30)))
                    .map_err(|error| error.to_string())?;
                return Ok(stream);
            }
            Err(error) if Instant::now() < deadline => {
                let _ = error;
                thread::sleep(Duration::from_millis(50));
            }
            Err(error) => return Err(format!("could not connect to Hara RESP endpoint: {error}")),
        }
    }
}

fn start_runtime(options: &Options) -> Result<Runtime, String> {
    let runtime = runtime_path(options)?;
    let project = service_project_path(options)?;
    let project_arg = project.to_string_lossy().into_owned();
    let root_arg = options.root.to_string_lossy().into_owned();
    let mut child = Command::new(&runtime)
        .args([
            "--project",
            project_arg.as_str(),
            "--root",
            root_arg.as_str(),
            "--allow-file",
            "--host",
            "127.0.0.1",
            "--port",
            "0",
            "headless",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not start Hara runtime {runtime:?}: {error}"))?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate_child(&mut child);
            return Err("Hara runtime stdout unavailable".into());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            terminate_child(&mut child);
            return Err("Hara runtime stderr unavailable".into());
        }
    };
    let endpoint = match stdout_endpoint(stdout).recv_timeout(Duration::from_secs(30)) {
        Ok(endpoint) => endpoint,
        Err(error) => {
            terminate_child(&mut child);
            return Err(format!("Hara runtime did not publish an endpoint: {error}"));
        }
    };
    drain_stderr(stderr);
    let stream = match connect_endpoint(endpoint) {
        Ok(stream) => stream,
        Err(error) => {
            terminate_child(&mut child);
            return Err(error);
        }
    };
    let mut runtime = Runtime {
        _child: child,
        stream,
        next_id: 0,
    };
    runtime.hello()?;
    Ok(runtime)
}

fn write_crlf<W: Write>(writer: &mut W, value: &[u8]) -> io::Result<()> {
    writer.write_all(value)?;
    writer.write_all(b"\r\n")
}

fn write_bulk<W: Write>(writer: &mut W, value: &[u8]) -> io::Result<()> {
    let header = "$".to_string() + &value.len().to_string();
    write_crlf(writer, header.as_bytes())?;
    writer.write_all(value)?;
    writer.write_all(b"\r\n")
}

fn write_array<W: Write>(writer: &mut W, values: &[String]) -> io::Result<()> {
    let header = "*".to_string() + &values.len().to_string();
    write_crlf(writer, header.as_bytes())?;
    for value in values {
        write_bulk(writer, value.as_bytes())?;
    }
    writer.flush()
}

fn read_line(stream: &mut TcpStream) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    let mut byte = [0; 1];
    loop {
        stream
            .read_exact(&mut byte)
            .map_err(|error| error.to_string())?;
        output.push(byte[0]);
        if output.ends_with(b"\r\n") {
            output.truncate(output.len() - 2);
            return Ok(output);
        }
    }
}

fn read_resp(stream: &mut TcpStream) -> Result<Resp, String> {
    let mut marker = [0; 1];
    stream
        .read_exact(&mut marker)
        .map_err(|error| error.to_string())?;
    match marker[0] {
        b'+' => Ok(Resp::Simple(
            String::from_utf8_lossy(&read_line(stream)?).into(),
        )),
        b'-' => Ok(Resp::Error(
            String::from_utf8_lossy(&read_line(stream)?).into(),
        )),
        b':' => {
            let line: i64 = String::from_utf8_lossy(&read_line(stream)?)
                .parse()
                .map_err(|_| "invalid RESP integer")?;
            Ok(Resp::Integer(line))
        }
        b'$' => {
            let length: i64 = String::from_utf8_lossy(&read_line(stream)?)
                .parse()
                .map_err(|_| "invalid RESP bulk length")?;
            if length < 0 {
                return Ok(Resp::Bulk(None));
            }
            let mut value = vec![0; length as usize];
            stream
                .read_exact(&mut value)
                .map_err(|error| error.to_string())?;
            let mut crlf = [0; 2];
            stream
                .read_exact(&mut crlf)
                .map_err(|error| error.to_string())?;
            if crlf != *b"\r\n" {
                return Err("invalid RESP bulk terminator".into());
            }
            Ok(Resp::Bulk(Some(value)))
        }
        b'*' => {
            let count: i64 = String::from_utf8_lossy(&read_line(stream)?)
                .parse()
                .map_err(|_| "invalid RESP array length")?;
            if count < 0 {
                return Ok(Resp::Array(None));
            }
            let mut values = Vec::with_capacity(count as usize);
            for _ in 0..count {
                values.push(read_resp(stream)?);
            }
            Ok(Resp::Array(Some(values)))
        }
        value => Err(format!("unknown RESP marker: {}", value as char)),
    }
}

fn resp_text(value: &Resp) -> Option<String> {
    match value {
        Resp::Simple(value) => Some(value.clone()),
        Resp::Bulk(Some(value)) => Some(String::from_utf8_lossy(value).into()),
        Resp::Integer(value) => Some(value.to_string()),
        _ => None,
    }
}

fn frame_field(frame: &Resp, index: usize) -> Option<String> {
    match frame {
        Resp::Array(Some(values)) => values.get(index).and_then(resp_text),
        _ => None,
    }
}

impl Runtime {
    fn hello(&mut self) -> Result<(), String> {
        write_array(
            &mut self.stream,
            &[
                "HELLO".into(),
                "4".into(),
                "CLIENT".into(),
                "HARA-LSP".into(),
            ],
        )
        .map_err(|error| error.to_string())?;
        match read_resp(&mut self.stream)? {
            Resp::Error(error) => Err(format!("Hara HELLO failed: {error}")),
            _ => Ok(()),
        }
    }

    fn evaluate(&mut self, request: &Value) -> Result<Value, String> {
        self.next_id += 1;
        let id = format!("LSP-{}", self.next_id);
        let json_text = serde_json::to_string(request).map_err(|error| error.to_string())?;
        let encoded = serde_json::to_string(&json_text).map_err(|error| error.to_string())?;
        let expression = format!(
            "(do (require [hara.lsp.service :as service]) (Json/write (service/handle (Json/read {}))))",
            encoded
        );
        write_array(&mut self.stream, &["EVAL".into(), id, expression])
            .map_err(|error| error.to_string())?;
        let mut result = None;
        loop {
            let frame = read_resp(&mut self.stream)?;
            if let Resp::Error(error) = frame {
                return Err(format!("Hara RESP error: {error}"));
            }
            match frame_field(&frame, 0).as_deref() {
                Some("RESULT") => result = frame_field(&frame, 2),
                Some("ERROR") => {
                    return Err(frame_field(&frame, 3)
                        .or_else(|| frame_field(&frame, 2))
                        .unwrap_or_else(|| "Hara evaluation failed".into()))
                }
                Some("DONE") => break,
                _ => {}
            }
        }
        let raw = result.ok_or("Hara evaluation returned no result")?;
        let parsed: Value = serde_json::from_str(&raw)
            .map_err(|error| format!("Hara LSP result was not JSON: {error}: {raw}"))?;
        if let Value::String(value) = parsed {
            serde_json::from_str(&value)
                .map_err(|error| format!("Hara LSP result was not JSON: {error}"))
        } else {
            Ok(parsed)
        }
    }
}

fn read_lsp_message<R: Read>(reader: &mut R) -> Result<Option<Vec<u8>>, String> {
    let mut headers = Vec::new();
    let mut byte = [0; 1];
    loop {
        let count = reader.read(&mut byte).map_err(|error| error.to_string())?;
        if count == 0 {
            if headers.is_empty() {
                return Ok(None);
            }
            return Err("unexpected EOF in LSP headers".into());
        }
        headers.push(byte[0]);
        if headers.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    let header_text = String::from_utf8_lossy(&headers);
    let length = header_text
        .lines()
        .find_map(|line| {
            line.strip_prefix("Content-Length:")?
                .trim()
                .parse::<usize>()
                .ok()
        })
        .ok_or("LSP message has no Content-Length")?;
    let mut body = vec![0; length];
    reader
        .read_exact(&mut body)
        .map_err(|error| error.to_string())?;
    Ok(Some(body))
}

fn write_lsp_message<W: Write>(writer: &mut W, value: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    write!(writer, "Content-Length: {}\r\n\r\n", body.len()).map_err(|error| error.to_string())?;
    writer.write_all(&body).map_err(|error| error.to_string())?;
    writer.flush().map_err(|error| error.to_string())
}

fn process_message(runtime: &mut Runtime, request: Value) -> Result<Option<Value>, String> {
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    if method == "exit" {
        return Ok(None);
    }
    let envelope = runtime.evaluate(&request)?;
    let notifications = envelope
        .get("notifications")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut stdout = io::stdout();
    for notification in notifications {
        write_lsp_message(&mut stdout, &notification)?;
    }
    if envelope.get("response").is_some() && !envelope["response"].is_null() {
        Ok(Some(envelope["response"].clone()))
    } else {
        Ok(Some(json!(null)))
    }
}

fn run() -> Result<(), String> {
    let options = parse_options()?;
    let mut runtime = start_runtime(&options)?;
    let stdin = io::stdin();
    let mut reader = stdin.lock();
    let mut stdout = io::stdout();
    while let Some(body) = read_lsp_message(&mut reader)? {
        let request: Value = serde_json::from_slice(&body).map_err(|error| error.to_string())?;
        let is_exit = request.get("method").and_then(Value::as_str) == Some("exit");
        let id = request.get("id").cloned();
        match process_message(&mut runtime, request) {
            Ok(Some(response)) if !response.is_null() => write_lsp_message(&mut stdout, &response)?,
            Ok(Some(_)) | Ok(None) => {}
            Err(error) => {
                if let Some(id) = id {
                    let response = json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": {"code": -32603, "message": error}
                    });
                    write_lsp_message(&mut stdout, &response)?;
                } else {
                    eprintln!("hara-lsp: {error}");
                }
            }
        }
        if is_exit {
            break;
        }
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("hara-lsp: {error}");
        std::process::exit(1);
    }
}
