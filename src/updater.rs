use tracing::warn;

const GITHUB_REPO: &str = "itouakirai/am-hook";

type Error = Box<dyn std::error::Error + Send + Sync>;

/// 解析 "v1.2.3" / "1.2.3-beta" 为 (1, 2, 3)；缺省的段按 0 处理，预发布后缀忽略
#[cfg(test)]
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

#[cfg(test)]
fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_version(latest), parse_version(current)) {
        (Some(l), Some(c)) => l > c,
        _ => false,
    }
}

/// 本仓库为自定义魔改分支（部署于自建 VPS），禁用向 upstream (`itouakirai/am-hook`) 的
/// 自动覆盖更新，避免误触发 `--auto-update` 破坏现有二进制或导致 aarch64 不兼容。
pub async fn check_update() -> Result<Option<String>, Error> {
    Err("Self-update against upstream is disabled on this custom fork".into())
}

pub async fn download_and_update(_tag: &str) -> Result<(), Error> {
    Err("Self-update against upstream is disabled on this custom fork; rebuild from git source instead".into())
}

/// 启动时提示自更新已禁用，不向 GitHub 发起覆盖请求
pub async fn startup_check(auto_update: bool) {
    warn!(
        auto_update,
        "Update check / auto-update against upstream ({GITHUB_REPO}) is disabled on this custom fork; update via git + cargo build"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_update_returns_err() {
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        assert!(rt.block_on(check_update()).is_err());
        assert!(rt.block_on(download_and_update("v9.9.9")).is_err());
    }

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
