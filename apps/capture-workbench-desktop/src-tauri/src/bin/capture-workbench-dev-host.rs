fn main() {
    if let Err(error) = capture_workbench_desktop::run_cli() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
