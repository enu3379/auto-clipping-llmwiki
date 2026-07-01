// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    match llm_wiki_lib::cli::try_run_from_env() {
        Ok(true) => {}
        Ok(false) => llm_wiki_lib::run(),
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    }
}
