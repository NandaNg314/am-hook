use std::sync::Arc;

use clap::Parser;
use tracing::info;

use am_hook::cli::Cli;
use am_hook::state::AppState;
use am_hook::{amp, log, monitor, router, updater};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    log::init();

    let cli = Cli::parse();

    // 检查更新
    if cli.auto_update {
        info!("Checking for updates and auto-updating if available...");
        updater::auto_update().await;
    } else if cli.check_update {
        info!("Checking for updates...");
        match updater::check_update().await {
            Ok(Some(version)) => {
                info!("New version available: {}", version);
                info!("Run with --auto-update to automatically install updates");
            }
            Ok(None) => {
                info!("Already running the latest version");
            }
            Err(e) => {
                info!("Failed to check for updates: {}", e);
            }
        }
    }

    let listen_addr = cli.resolve_listen_addr()?;
    let config = cli.config()?;
    let state = Arc::new(AppState::with_config(config.clone(), cli.lru_cache_mb));
    if cli.hook {
        // 预热内嵌模板，避免首个请求时解析
        am_mp4::fixed_template();
        tokio::spawn(monitor::run_background_monitor(state.clone()));
    }
    // 启动即获取 developer token 并建立 amp-api 连接，页面的首个目录 / 搜索请求无需等待
    tokio::spawn(amp::run_warmer(state.amp.clone(), config.amp_keepalive));

    let listener = tokio::net::TcpListener::bind(listen_addr).await?;
    log::print_banner(listen_addr, &config, cli.lru_cache_mb);
    tokio::spawn(log::check_wrapper(state.clone()));

    axum::serve(listener, router(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            info!("Shutting down");
        })
        .await?;
    Ok(())
}
