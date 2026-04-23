use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::process::Command;
use tempfile::TempDir;

fn make_executable(path: &std::path::Path, content: &str) {
    fs::write(path, content).unwrap();
    let mut perms = fs::metadata(path).unwrap().permissions();
    perms.set_mode(0o755);
    fs::set_permissions(path, perms).unwrap();
}

fn bash_with_path(path: &str, script: &str) -> std::process::Output {
    Command::new("bash")
        .arg("-c")
        .arg(script)
        .env("PATH", path)
        .output()
        .expect("failed to run bash")
}

#[test]
fn build_script_is_valid_bash() {
    let output = Command::new("bash")
        .arg("-n")
        .arg("build-release-app.sh")
        .output()
        .expect("failed to syntax-check build-release-app.sh");

    assert!(
        output.status.success(),
        "bash -n failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn create_notary_archive_uses_ditto_and_writes_archive() {
    let temp = TempDir::new().unwrap();
    let bin_dir = temp.path().join("bin");
    fs::create_dir(&bin_dir).unwrap();
    let log_path = temp.path().join("ditto.log");
    let archive_path = temp.path().join("Handtyped.zip");

    make_executable(
        &bin_dir.join("ditto"),
        &format!(
            r#"#!/bin/bash
set -euo pipefail
printf '%s\n' "$@" >> "{}"
last="${{!#}}"
touch "$last"
"#,
            log_path.display()
        ),
    );

    let app_dir = temp.path().join("Handtyped.app");
    fs::create_dir_all(app_dir.join("Contents/MacOS")).unwrap();
    fs::write(app_dir.join("Contents/MacOS/Handtyped"), b"stub").unwrap();

    let path = format!(
        "{}:{}",
        bin_dir.display(),
        std::env::var("PATH").unwrap_or_default()
    );

    let script = format!(
        r#"
            set -euo pipefail
            source "{script_path}"
            create_notary_archive "{app}" "{archive}"
        "#,
        script_path = fs::canonicalize("build-release-app.sh").unwrap().display(),
        app = app_dir.display(),
        archive = archive_path.display()
    );

    let output = bash_with_path(&path, &script);
    assert!(
        output.status.success(),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(archive_path.exists(), "archive was not created");

    let log = fs::read_to_string(log_path).unwrap();
    assert!(log.contains("-c"));
    assert!(log.contains("--keepParent"));
    assert!(log.contains(app_dir.to_string_lossy().as_ref()));
    assert!(log.contains(archive_path.to_string_lossy().as_ref()));
}

#[test]
fn create_release_dmg_uses_hdiutil_and_targets_the_requested_path() {
    let temp = TempDir::new().unwrap();
    let bin_dir = temp.path().join("bin");
    fs::create_dir(&bin_dir).unwrap();
    let log_path = temp.path().join("hdiutil.log");
    let dmg_path = temp.path().join("Handtyped-macos.dmg");

    make_executable(
        &bin_dir.join("hdiutil"),
        &format!(
            r#"#!/bin/bash
set -euo pipefail
printf '%s\n' "$@" >> "{}"
last="${{!#}}"
touch "$last"
"#,
            log_path.display()
        ),
    );

    let app_dir = temp.path().join("Handtyped.app");
    fs::create_dir_all(app_dir.join("Contents/MacOS")).unwrap();
    fs::write(app_dir.join("Contents/MacOS/Handtyped"), b"stub").unwrap();

    let path = format!(
        "{}:{}",
        bin_dir.display(),
        std::env::var("PATH").unwrap_or_default()
    );

    let script = format!(
        r#"
            set -euo pipefail
            source "{script_path}"
            create_release_dmg "{app}" "{dmg}"
        "#,
        script_path = fs::canonicalize("build-release-app.sh").unwrap().display(),
        app = app_dir.display(),
        dmg = dmg_path.display()
    );

    let output = bash_with_path(&path, &script);
    assert!(
        output.status.success(),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(dmg_path.exists(), "dmg was not created");

    let log = fs::read_to_string(log_path).unwrap();
    assert!(log.contains("create"));
    assert!(log.contains("-format"));
    assert!(log.contains("UDZO"));
    assert!(log.contains("-volname"));
    assert!(log.contains("Handtyped"));
    assert!(log.contains("-srcfolder"));
    assert!(log.contains(app_dir.to_string_lossy().as_ref()));
    assert!(log.contains(dmg_path.to_string_lossy().as_ref()));
}

#[test]
fn publish_release_artifacts_copies_download_files_into_public_directory() {
    let temp = TempDir::new().unwrap();
    let public_dir = temp.path().join("replay-server/public/downloads");
    fs::create_dir_all(&public_dir).unwrap();

    let app_dir = temp.path().join("Handtyped.app");
    fs::create_dir_all(app_dir.join("Contents/MacOS")).unwrap();
    fs::write(app_dir.join("Contents/MacOS/Handtyped"), b"stub").unwrap();

    let dmg_path = temp.path().join("Handtyped-macos.dmg");
    let zip_path = temp.path().join("Handtyped-macos.zip");
    fs::write(&dmg_path, b"dmg-bytes").unwrap();
    fs::write(&zip_path, b"zip-bytes").unwrap();

    let script = format!(
        r#"
            set -euo pipefail
            source "{script_path}"
            publish_release_artifacts "{app}" "{dmg}" "{zip}"
        "#,
        script_path = fs::canonicalize("build-release-app.sh").unwrap().display(),
        app = app_dir.display(),
        dmg = dmg_path.display(),
        zip = zip_path.display()
    );

    let output = Command::new("bash")
        .arg("-lc")
        .arg(script)
        .env("PUBLIC_DOWNLOADS_DIR", &public_dir)
        .output()
        .expect("failed to run bash");

    assert!(
        output.status.success(),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let copied_dmg = public_dir.join("Handtyped-macos.dmg");
    let copied_zip = public_dir.join("Handtyped-macos.zip");
    assert_eq!(fs::read(copied_dmg).unwrap(), b"dmg-bytes");
    assert_eq!(fs::read(copied_zip).unwrap(), b"zip-bytes");
}

#[test]
fn submit_for_notarization_supports_keychain_profile_and_staples() {
    let temp = TempDir::new().unwrap();
    let bin_dir = temp.path().join("bin");
    fs::create_dir(&bin_dir).unwrap();
    let log_path = temp.path().join("xcrun.log");
    let app_dir = temp.path().join("Handtyped.app");
    let archive_path = temp.path().join("Handtyped.zip");

    fs::create_dir_all(app_dir.join("Contents/MacOS")).unwrap();
    fs::write(app_dir.join("Contents/MacOS/Handtyped"), b"stub").unwrap();
    fs::write(&archive_path, b"zip").unwrap();

    make_executable(
        &bin_dir.join("xcrun"),
        &format!(
            r#"#!/bin/bash
set -euo pipefail
printf '%s\n' "$@" >> "{}"
exit 0
"#,
            log_path.display()
        ),
    );

    let path = format!(
        "{}:{}",
        bin_dir.display(),
        std::env::var("PATH").unwrap_or_default()
    );

    let script = format!(
        r#"
            set -euo pipefail
            source "{script_path}"
            HANDTYPED_NOTARY_KEYCHAIN_PROFILE="handtyped-notary"
            submit_for_notarization "{archive}" "{app}"
        "#,
        script_path = fs::canonicalize("build-release-app.sh").unwrap().display(),
        archive = archive_path.display(),
        app = app_dir.display()
    );

    let output = bash_with_path(&path, &script);
    assert!(
        output.status.success(),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let log = fs::read_to_string(log_path).unwrap();
    assert!(log.contains("notarytool"));
    assert!(log.contains("submit"));
    assert!(log.contains("--keychain-profile"));
    assert!(log.contains("handtyped-notary"));
    assert!(log.contains("stapler"));
    assert!(log.contains("staple"));
    assert!(log.contains("validate"));
}

#[test]
fn submit_for_notarization_requires_credentials() {
    let script = format!(
        r#"
            set -euo pipefail
            source "{script_path}"
            submit_for_notarization "/tmp/fake.zip" "/tmp/fake.app"
        "#,
        script_path = fs::canonicalize("build-release-app.sh").unwrap().display(),
    );

    let output = Command::new("bash")
        .arg("-lc")
        .arg(script)
        .output()
        .expect("failed to run bash");

    assert!(!output.status.success());
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(combined.contains("Missing notarization credentials."));
}
