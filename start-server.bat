@echo off
setlocal
cd /d "%~dp0"
echo Starting Multiplayer console (True Dark GUI on http://127.0.0.1:7778 )...
echo Game server will bind 0.0.0.0:7777 - use Restart in the GUI to rebuild.
echo Use Shutdown in the GUI to stop everything and close this window.
cargo run --release --manifest-path server\Cargo.toml --bin multiplayer-console -- %*
