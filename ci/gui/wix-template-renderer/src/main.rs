use std::{env, fs, process::ExitCode};

fn render() -> Result<(), &'static str> {
    let arguments: Vec<_> = env::args_os().collect();
    if arguments.len() != 4 {
        return Err("usage: easytier-wix-template-renderer <template> <context.json> <output>");
    }

    let template = fs::read_to_string(&arguments[1])
        .map_err(|_| "cannot read the UTF-8 template")?;
    let context = fs::read_to_string(&arguments[2])
        .map_err(|_| "cannot read the UTF-8 context")?;
    let context: serde_json::Value =
        serde_json::from_str(&context).map_err(|_| "context is not valid JSON")?;
    if !context.is_object() {
        return Err("context must be a JSON object");
    }

    // Match tauri-bundler's WiX renderer; preserve its default non-strict mode.
    let mut handlebars = handlebars::Handlebars::new();
    handlebars.register_escape_fn(handlebars::no_escape);
    handlebars
        .register_template_string("main.wxs", template)
        .map_err(|_| "cannot parse the Handlebars template")?;
    let rendered = handlebars
        .render("main.wxs", &context)
        .map_err(|_| "cannot render the Handlebars template")?;
    fs::write(&arguments[3], rendered).map_err(|_| "cannot write the UTF-8 output")?;
    Ok(())
}

fn main() -> ExitCode {
    match render() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            // Never emit template/context contents or raw Rust error details.
            eprintln!("WiX template renderer: {message}");
            ExitCode::FAILURE
        }
    }
}
