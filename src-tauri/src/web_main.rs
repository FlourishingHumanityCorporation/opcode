use clap::Parser;

mod agent_binary;
mod checkpoint;
mod claude_binary;
mod commands;
mod logging;
mod process;
mod providers;
mod rebrand;
mod usage_index;
mod web_server;

#[derive(Parser)]
#[command(name = "codeinterfacex-web")]
#[command(about = "CodeInterfaceX Web Server - Access CodeInterfaceX from your phone")]
struct Args {
    /// Port to run the web server on
    #[arg(short, long, default_value = "8080")]
    port: u16,

    /// Host to bind to (0.0.0.0 for all interfaces)
    #[arg(short = 'H', long, default_value = "0.0.0.0")]
    host: String,
}

#[tokio::main]
async fn main() {
    logging::init();
    rebrand::archive_legacy_opcode_state();

    let args = Args::parse();

    println!("🚀 Starting CodeInterfaceX Web Server...");
    println!(
        "📱 Will be accessible from phones at: http://{}:{}",
        args.host, args.port
    );

    if let Err(e) = web_server::start_web_mode(Some(args.port)).await {
        eprintln!("❌ Failed to start web server: {}", e);
        std::process::exit(1);
    }
}
