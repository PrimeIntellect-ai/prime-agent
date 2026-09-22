fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = pa_cli::main_with_runtime(args, &pa_cli::PrintRuntime);
    std::process::exit(code);
}
