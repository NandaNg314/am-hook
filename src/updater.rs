use serde::Deserialize;
use std::env;
use std::fs;
use std::time::Duration;
use tracing::{info, warn};

const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const GITHUB_REPO: &str = "itouakirai/am-hook";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const API_TIMEOUT: Duration = Duration::from_secs(15);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);

type Error = Box<dyn std::error::Error + Send + Sync>;

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
}

fn client() -> Result<reqwest::Client, Error> {
    Ok(reqwest::Client::builder()
        .user_agent("am-hook-updater")
        .connect_timeout(CONNECT_TIMEOUT)
        .build()?)
}

/// 解析 "v1.2.3" / "1.2.3-beta" 为 (1, 2, 3)；缺省的段按 0 处理，预发布后缀忽略
fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    let core = s.trim_start_matches('v').split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|p| p.parse::<u64>());
    let major = parts.next()?.ok()?;
    let minor = parts.next().unwrap_or(Ok(0)).ok()?;
    let patch = parts.next().unwrap_or(Ok(0)).ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_version(latest), parse_version(current)) {
        (Some(l), Some(c)) => l > c,
        _ => false,
    }
}

/// 有新版本时返回其 tag
pub async fn check_update() -> Result<Option<String>, Error> {
    let url = format!("https://api.github.com/repos/{}/releases/latest", GITHUB_REPO);
    let release: GithubRelease = client()?
        .get(&url)
        .timeout(API_TIMEOUT)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    if is_newer(&release.tag_name, CURRENT_VERSION) {
        Ok(Some(release.tag_name))
    } else {
        Ok(None)
    }
}

pub async fn download_and_update(tag: &str) -> Result<(), Error> {
    let asset_name = platform_asset_name()?;
    let url = format!(
        "https://github.com/{}/releases/download/{}/{}",
        GITHUB_REPO, tag, asset_name
    );

    info!("Downloading update from: {}", url);

    let bytes = client()?
        .get(&url)
        .timeout(DOWNLOAD_TIMEOUT)
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;

    // 获取当前可执行文件路径
    let current_exe = env::current_exe()?;
    let current_dir = current_exe.parent().ok_or("Cannot get exe directory")?;
    let temp_path = current_dir.join(format!("am-hook-new{}", env::consts::EXE_SUFFIX));

    // 写入临时文件
    fs::write(&temp_path, &bytes)?;

    // Windows 和 Unix 的替换策略不同
    #[cfg(windows)]
    {
        // Windows 无法替换正在运行的 exe，需要使用 self-replace crate 或提示重启
        warn!("Update downloaded to: {:?}", temp_path);
        warn!("Please restart am-hook to complete the update");
        warn!("Manual steps:");
        warn!("  1. Stop am-hook");
        warn!("  2. Rename {:?} to a backup name", current_exe.file_name().unwrap_or_default());
        warn!("  3. Rename {:?} to {:?}", temp_path.file_name().unwrap_or_default(), current_exe.file_name().unwrap_or_default());
        warn!("  4. Restart am-hook");
    }

    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;

        let backup_path = current_dir.join("am-hook-backup");
        let replace = || -> std::io::Result<()> {
            fs::set_permissions(&temp_path, fs::Permissions::from_mode(0o755))?;
            // 先复制备份，再用 rename 原子覆盖；任一步失败时当前可执行文件保持不变
            fs::copy(&current_exe, &backup_path)?;
            fs::rename(&temp_path, &current_exe)
        };
        if let Err(e) = replace() {
            let _ = fs::remove_file(&temp_path);
            return Err(e.into());
        }
        info!("Update complete! Please restart am-hook");
        info!("Backup saved to: {:?}", backup_path);
    }

    Ok(())
}

fn platform_asset_name() -> Result<&'static str, Error> {
    let os = env::consts::OS;
    let arch = env::consts::ARCH;

    match (os, arch) {
        ("windows", "x86_64") => Ok("am-hook-windows-x86_64.exe"),
        ("linux", "x86_64") => Ok("am-hook-linux-x86_64"),
        ("macos", "x86_64") => Ok("am-hook-macos-x86_64"),
        ("macos", "aarch64") => Ok("am-hook-macos-aarch64"),
        _ => Err(format!("No prebuilt release for platform: {}-{}", os, arch).into()),
    }
}

/// 启动时在后台运行，GitHub 不可达时不影响服务启动
pub async fn startup_check(auto_update: bool) {
    let tag = match check_update().await {
        Ok(Some(tag)) => tag,
        Ok(None) => {
            info!("Already running the latest version: {}", CURRENT_VERSION);
            return;
        }
        Err(e) => {
            warn!("Failed to check for updates: {}", e);
            return;
        }
    };
    info!("New version available: {} (current: {})", tag, CURRENT_VERSION);
    if !auto_update {
        info!("Run with --auto-update to automatically install updates");
        return;
    }
    info!("Attempting to download and install update: {}", tag);
    if let Err(e) = download_and_update(&tag).await {
        warn!("Failed to update: {}", e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_compare_is_numeric() {
        assert!(is_newer("v0.10.0", "0.9.0"));
        assert!(is_newer("v0.2.1", "0.2.0"));
        assert!(is_newer("1.0", "0.99.99"));
        assert!(!is_newer("v0.2.0", "0.2.0"));
        assert!(!is_newer("v0.1.9", "0.2.0"));
        assert!(!is_newer("v0.3.0-beta", "0.3.0"));
        assert!(!is_newer("nightly", "0.2.0"));
        assert!(!is_newer("v1.2.3.4", "0.2.0"));
    }
}
