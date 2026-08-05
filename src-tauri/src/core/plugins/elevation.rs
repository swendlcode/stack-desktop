//! One-shot privileged deletion: the whole batch goes through a single
//! authorization prompt (macOS `osascript … with administrator privileges`,
//! Windows UAC via `Start-Process -Verb RunAs`).

use super::deletion::ElevationOutcome;

#[cfg(target_os = "macos")]
pub fn delete_elevated(paths: &[String], _hklm_keys: &[String]) -> ElevationOutcome {
    if paths.is_empty() {
        return ElevationOutcome::Success;
    }
    let quoted: Vec<String> = paths.iter().map(|p| shell_quote(p)).collect();
    let shell_cmd = format!("/bin/rm -rf -- {}", quoted.join(" "));
    let script = format!(
        "do shell script \"{}\" with administrator privileges",
        applescript_escape(&shell_cmd)
    );

    match std::process::Command::new("osascript")
        .args(["-e", &script])
        .output()
    {
        Ok(output) if output.status.success() => ElevationOutcome::Success,
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            if stderr.contains("-128") || stderr.to_lowercase().contains("user cancel") {
                ElevationOutcome::Cancelled
            } else {
                ElevationOutcome::Failed(stderr.trim().to_string())
            }
        }
        Err(e) => ElevationOutcome::Failed(e.to_string()),
    }
}

#[cfg(target_os = "macos")]
fn shell_quote(path: &str) -> String {
    format!("'{}'", path.replace('\'', r"'\''"))
}

#[cfg(target_os = "macos")]
fn applescript_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(target_os = "windows")]
pub fn delete_elevated(paths: &[String], hklm_keys: &[String]) -> ElevationOutcome {
    use std::fmt::Write as _;

    if paths.is_empty() && hklm_keys.is_empty() {
        return ElevationOutcome::Success;
    }

    let mut script = String::from("@echo off\r\n");
    for p in paths {
        let is_dir = std::path::Path::new(p).is_dir();
        if is_dir {
            let _ = writeln!(script, "rd /s /q \"{p}\"\r");
        } else {
            let _ = writeln!(script, "del /f /q \"{p}\"\r");
        }
    }
    for key in hklm_keys {
        let _ = writeln!(script, "reg delete \"{key}\" /f\r");
    }

    let script_path = std::env::temp_dir().join(format!(
        "stack-plugin-delete-{}.cmd",
        std::process::id()
    ));
    if let Err(e) = std::fs::write(&script_path, script) {
        return ElevationOutcome::Failed(e.to_string());
    }

    let ps_command = format!(
        "$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','\"{}\"' -Verb RunAs -Wait -PassThru; exit $p.ExitCode",
        script_path.display()
    );
    let result = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps_command])
        .output();
    let _ = std::fs::remove_file(&script_path);

    match result {
        Ok(output) if output.status.success() => ElevationOutcome::Success,
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
            // ERROR_CANCELLED (1223): the user declined the UAC prompt.
            if stderr.contains("cancel") || stderr.contains("1223") {
                ElevationOutcome::Cancelled
            } else {
                ElevationOutcome::Failed(stderr.trim().to_string())
            }
        }
        Err(e) => ElevationOutcome::Failed(e.to_string()),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn delete_elevated(_paths: &[String], _hklm_keys: &[String]) -> ElevationOutcome {
    ElevationOutcome::Failed("privileged deletion is not supported on this OS".to_string())
}
