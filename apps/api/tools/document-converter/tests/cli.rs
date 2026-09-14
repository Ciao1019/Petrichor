use serde_json::{Value, json};
use std::fs::{self, OpenOptions};
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Input(PathBuf);
impl Input {
    fn new(bytes: &[u8]) -> Self {
        let root = std::env::var_os("PI_SCRATCH_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let path = root.join(format!(
            "petrichor-converter-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        use std::io::Write;
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap()
            .write_all(bytes)
            .unwrap();
        Self(path)
    }
    fn run(&self, format: &str) -> Output {
        Command::new(env!("CARGO_BIN_EXE_petrichor-doc-convert"))
            .arg("--input")
            .arg(&self.0)
            .arg("--format")
            .arg(format)
            .output()
            .unwrap()
    }
}
impl Drop for Input {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn json_output(output: Output) -> Value {
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty());
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn version_cli_errors_and_business_errors() {
    let version = Command::new(env!("CARGO_BIN_EXE_petrichor-doc-convert"))
        .arg("--version")
        .output()
        .unwrap();
    assert!(version.status.success());
    assert_eq!(version.stdout, b"petrichor-doc-convert 0.1.0\n");
    assert!(version.stderr.is_empty());
    for args in [
        vec![],
        vec!["--input", "relative", "--format", "csv"],
        vec!["--input", "/secret", "--input", "/secret"],
        vec!["--version", "secret"],
    ] {
        let result = Command::new(env!("CARGO_BIN_EXE_petrichor-doc-convert"))
            .args(args)
            .output()
            .unwrap();
        assert_eq!(result.status.code(), Some(2));
        assert!(result.stdout.is_empty());
        assert_eq!(result.stderr, b"invalid arguments\n");
    }
    let input = Input::new(b"private malformed body");
    assert_eq!(
        json_output(input.run("pdf")),
        json!({"ok": false, "code": "malformed"})
    );
    assert_eq!(
        json_output(input.run("exe")),
        json!({"ok": false, "code": "unsupported"})
    );
    assert_eq!(
        json_output(input.run("md")),
        json!({"ok": false, "code": "unsupported"})
    );
}

#[test]
fn source_is_read_only_regular_and_bounded() {
    let input = Input::new(b"name,value\nhello,2\n");
    let before = fs::read(&input.0).unwrap();
    assert_eq!(json_output(input.run("CSV"))["ok"], true);
    assert_eq!(fs::read(&input.0).unwrap(), before);
    OpenOptions::new()
        .write(true)
        .open(&input.0)
        .unwrap()
        .set_len(petrichor_doc_convert::MAX_SOURCE_BYTES + 1)
        .unwrap();
    assert_eq!(
        json_output(input.run("csv")),
        json!({"ok": false, "code": "resourceLimit"})
    );
    let directory = Input(input.0.parent().unwrap().to_path_buf());
    assert_eq!(
        json_output(directory.run("csv")),
        json!({"ok": false, "code": "io"})
    );
    std::mem::forget(directory);
}

#[cfg(unix)]
#[test]
fn symlinks_and_pipes_are_rejected_without_blocking() {
    use std::os::unix::fs::symlink;
    let source = Input::new(b"a,b\n1,2\n");
    let link = Input(source.0.with_extension("link"));
    symlink(&source.0, &link.0).unwrap();
    assert_eq!(
        json_output(link.run("csv")),
        json!({"ok": false, "code": "io"})
    );
    let pipe = Input(source.0.with_extension("fifo"));
    let path = std::ffi::CString::new(pipe.0.as_os_str().as_encoded_bytes()).unwrap();
    // 仅创建测试目录内 FIFO，不读取任何系统设备或用户数据。
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    assert_eq!(
        json_output(pipe.run("csv")),
        json!({"ok": false, "code": "io"})
    );
}
