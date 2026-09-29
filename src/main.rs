use std::sync::Arc;

use clap::Parser;
use tracing::info;

use am_hook::cli::Cli;
use am_hook::state::AppState;
use am_hook::{log, monitor, router};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    log::init();

    let cli = Cli::parse();
    let listen_addr = cli.resolve_listen_addr()?;
    let config = cli.config();
    let state = Arc::new(AppState::with_config(config.clone(), cli.lru_cache_mb));
    if cli.hook {
        // 预热内嵌模板，避免首个请求时解析
        am_mp4::fixed_template();
        tokio::spawn(monitor::run_background_monitor(state.clone()));
    }

    let listener = tokio::net::TcpListener::bind(listen_addr).await?;
    log::print_banner(listen_addr, &config, cli.lru_cache_mb);
    tokio::spawn(log::check_wrapper(state.http_client.clone(), config.wrapper_url.clone()));

    axum::serve(listener, router(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            info!("Shutting down");
        })
        .await?;
    Ok(())
}
