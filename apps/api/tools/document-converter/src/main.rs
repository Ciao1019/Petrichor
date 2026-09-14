use petrichor_doc_convert::{Failure, convert_file};
use std::ffi::OsString;
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::ExitCode;

enum Command {
    Version,
    Convert { input: PathBuf, format: String },
}

fn parse(args: Vec<OsString>) -> Result<Command, ()> {
    if args.as_slice() == [OsString::from("--version")] {
        return Ok(Command::Version);
    }
    if args.len() != 4 {
        return Err(());
    }
    let mut input = None;
    let mut format = None;
    for pair in args.chunks_exact(2) {
        match pair[0].to_str() {
            Some("--input") if input.is_none() => input = Some(PathBuf::from(&pair[1])),
            Some("--format") if format.is_none() => {
                let value = pair[1].to_str().ok_or(())?;
                if value.is_empty() || !value.bytes().all(|b| b.is_ascii_alphanumeric()) {
                    return Err(());
                }
                format = Some(value.to_ascii_lowercase());
            }
            _ => return Err(()),
        }
    }
    let input = input.filter(|path| path.is_absolute()).ok_or(())?;
    Ok(Command::Convert {
        input,
        format: format.ok_or(())?,
    })
}

fn main() -> ExitCode {
    // 第三方解析器 panic 也不能泄露正文、路径或原始错误；OOM/硬限额由父进程处理。
    std::panic::set_hook(Box::new(|_| {}));
    let command = match parse(std::env::args_os().skip(1).collect()) {
        Ok(command) => command,
        Err(()) => {
            eprintln!("invalid arguments");
            return ExitCode::from(2);
        }
    };
    let output = match command {
        Command::Version => format!("petrichor-doc-convert {}\n", env!("CARGO_PKG_VERSION")),
        Command::Convert { input, format } => {
            let value = std::panic::catch_unwind(|| convert_file(&input, &format))
                .unwrap_or(Err(Failure::Malformed))
                .unwrap_or_else(Failure::json);
            format!("{value}\n")
        }
    };
    if io::stdout().lock().write_all(output.as_bytes()).is_err() {
        eprintln!("output unavailable");
        return ExitCode::from(2);
    }
    ExitCode::SUCCESS
}
