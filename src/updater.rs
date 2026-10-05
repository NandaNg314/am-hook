use serde::Deserialize;
use std::env;
use std::fs;
use tracing::{info, warn, error};

const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const GITHUB_REPO: &str = "itouakirai/am-hook";

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[allow(dead_code)]
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

pub async fn check_update() -> Result<Option<String>, Box<dyn std::error::Error>> {
    let url = format!("https://api.github.com/repos/{}/releases/latest", GITHUB_REPO);
    let client = reqwest::Client::builder()
        .user_agent("am-hook-updater")
        .build()?;

    let release: GithubRelease = client
        .get(&url)
        .send()
        .await?
        .json()
        .await?;

    let latest_version = release.tag_name.trim_start_matches('v');
    let current_version = CURRENT_VERSION.trim_start_matches('v');

    if latest_version > current_version {
        info!("New version available: {} (current: {})", latest_version, current_version);
        Ok(Some(release.tag_name))
    } else {
        info!("Already running the latest version: {}", current_version);
        Ok(None)
    }
}

pub async fn download_and_update(tag: &str) -> Result<(), Box<dyn std::error::Error>> {
    let asset_name = get_platform_asset_name();
    let url = format!(
        "https://github.com/{}/releases/download/{}/{}",
        GITHUB_REPO, tag, asset_name
    );

    info!("Downloading update from: {}", url);

    let client = reqwest::Client::builder()
        .user_agent("am-hook-updater")
        .build()?;

    let response = client.get(&url).send().await?;
    if !response.status().is_success() {
        return Err(format!("Failed to download: HTTP {}", response.status()).into());
    }

    let bytes = response.bytes().await?;

    // 获取当前可执行文件路径
    let current_exe = env::current_exe()?;
    let current_dir = current_exe.parent().ok_or("Cannot get exe directory")?;
    let temp_path = current_dir.join(format!("am-hook-new{}", env::consts::EXE_SUFFIX));

    // 写入临时文件
    fs::write(&temp_path, &bytes)?;

    // Unix 系统设置执行权限
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&temp_path)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&temp_path, perms)?;
    }

    // 备份当前可执行文件
    let backup_path = current_dir.join(format!("am-hook-backup{}", env::consts::EXE_SUFFIX));
    if backup_path.exists() {
        fs::remove_file(&backup_path)?;
    }

    info!("Replacing executable...");

    // Windows 和 Unix 的替换策略不同
    #[cfg(windows)]
    {
        // Windows 无法替换正在运行的 exe，需要使用 self-replace crate 或提示重启
        warn!("Update downloaded to: {:?}", temp_path);
        warn!("Please restart am-hook to complete the update");
        warn!("Manual steps:");
        warn!("  1. Stop am-hook");
        warn!("  2. Rename am-hook.exe to am-hook-backup.exe");
        warn!("  3. Rename am-hook-new.exe to am-hook.exe");
        warn!("  4. Restart am-hook");
    }

    #[cfg(not(windows))]
    {
        // Unix 系统可以直接替换
        fs::rename(&current_exe, &backup_path)?;
        fs::rename(&temp_path, &current_exe)?;
        info!("Update complete! Please restart am-hook");
        info!("Backup saved to: {:?}", backup_path);
    }

    Ok(())
}

fn get_platform_asset_name() -> String {
    let os = env::consts::OS;
    let arch = env::consts::ARCH;

    match (os, arch) {
        ("windows", "x86_64") => "am-hook-windows-x86_64.exe".to_string(),
        ("linux", "x86_64") => "am-hook-linux-x86_64".to_string(),
        ("macos", "x86_64") => "am-hook-macos-x86_64".to_string(),
        ("macos", "aarch64") => "am-hook-macos-aarch64".to_string(),
        _ => panic!("Unsupported platform: {}-{}", os, arch),
    }
}

pub async fn auto_update() {
    match check_update().await {
        Ok(Some(tag)) => {
            info!("Attempting to download and install update: {}", tag);
            if let Err(e) = download_and_update(&tag).await {
                error!("Failed to update: {}", e);
            }
        }
        Ok(None) => {}
        Err(e) => {
            warn!("Failed to check for updates: {}", e);
        }
    }
}
