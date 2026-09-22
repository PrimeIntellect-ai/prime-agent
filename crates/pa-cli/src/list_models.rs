//! `prime-agent model list [search]`: the models catalog table. Port of
//! `cli/list-models.ts` — registry refresh, fuzzy search, and the
//! provider/model/context/max-out/thinking/images table.

use crate::mode::RunOptions;

/// Run the model-list runtime path: build the registry against the agent
/// dir, refresh entitlements, and print the catalog table. The TS product
/// exits 0 after listing (including the no-models message).
pub fn run(options: &RunOptions) -> Result<i32, String> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    rt.block_on(list(options))
}

async fn list(options: &RunOptions) -> Result<i32, String> {
    let config = &options.config;
    let auth = pa_core::auth::AuthStorage::create(&config.agent_dir);
    let mut registry =
        pa_core::models::ModelRegistry::create(auth, config.agent_dir.join("models.json"));
    if let Some(error) = registry.get_error() {
        eprintln!("Warning: errors loading models.json:\n{error}");
    }
    let models = registry.refresh_available_models().await;
    if models.is_empty() {
        println!("{}", no_models_available_message());
        return Ok(0);
    }
    let search = options.list_models.clone().flatten();
    let mut filtered = match search {
        Some(pattern) => {
            let matched =
                pa_tui::fuzzy::fuzzy_filter(&models, &pattern, |model: &pa_types::ai::Model| {
                    format!("{} {}", model.provider, model.id)
                });
            if matched.is_empty() {
                println!("No models matching \"{pattern}\"");
                return Ok(0);
            }
            matched
        }
        None => models,
    };
    filtered.sort_by(|a, b| a.provider.cmp(&b.provider).then_with(|| a.id.cmp(&b.id)));
    print_table(&filtered);
    Ok(0)
}

/// The TS `formatNoModelsAvailableMessage`: guidance plus the bundled docs
/// paths for providers and models.
fn no_models_available_message() -> String {
    let docs = pa_core::packages::docs_path();
    format!(
        "No models available. Use /login to log into a provider via OAuth or API key. See:\n  {}\n  {}",
        docs.join("providers.md").display(),
        docs.join("models.md").display()
    )
}

/// One table row's rendered columns.
struct Row {
    provider: String,
    model: String,
    context: String,
    max_out: String,
    thinking: String,
    images: String,
}

impl Row {
    fn from_model(model: &pa_types::ai::Model) -> Self {
        Row {
            provider: model.provider.clone(),
            model: model.id.clone(),
            context: format_token_count(model.context_window),
            max_out: format_token_count(model.max_tokens),
            thinking: yes_no(model.reasoning),
            images: yes_no(
                model
                    .input
                    .iter()
                    .any(|input| matches!(input, pa_types::ai::ModelInput::Image)),
            ),
        }
    }

    fn cells(&self) -> [&str; 6] {
        [
            &self.provider,
            &self.model,
            &self.context,
            &self.max_out,
            &self.thinking,
            &self.images,
        ]
    }
}

fn yes_no(value: bool) -> String {
    (if value { "yes" } else { "no" }).to_string()
}

/// The TS `formatTokenCount`: `1M`/`1.0M`, `128K`/`163.8K`, plain below 1K.
fn format_token_count(count: u64) -> String {
    let count = count as f64;
    if count >= 1_000_000.0 {
        let millions = count / 1_000_000.0;
        if millions.fract() == 0.0 {
            format!("{millions}M")
        } else {
            format!("{millions:.1}M")
        }
    } else if count >= 1_000.0 {
        let thousands = count / 1_000.0;
        if thousands.fract() == 0.0 {
            format!("{thousands}K")
        } else {
            format!("{thousands:.1}K")
        }
    } else {
        format!("{}", count as u64)
    }
}

/// The catalog table: fixed headers, two-space gutters, and every column
/// padded to its widest value (trailing padding included, like the TS
/// `padEnd` render).
fn print_table(models: &[pa_types::ai::Model]) {
    const HEADERS: [&str; 6] = [
        "provider", "model", "context", "max-out", "thinking", "images",
    ];
    let rows: Vec<Row> = models.iter().map(Row::from_model).collect();
    let mut widths = [0usize; 6];
    for (index, header) in HEADERS.iter().enumerate() {
        widths[index] = header.chars().count();
    }
    for row in &rows {
        for (index, cell) in row.cells().iter().enumerate() {
            widths[index] = widths[index].max(cell.chars().count());
        }
    }
    let line = |cells: [&str; 6]| -> String {
        cells
            .iter()
            .zip(widths)
            .map(|(cell, width)| pad_end(cell, width))
            .collect::<Vec<_>>()
            .join("  ")
    };
    println!("{}", line(HEADERS));
    for row in &rows {
        println!("{}", line(row.cells()));
    }
}

fn pad_end(value: &str, width: usize) -> String {
    let len = value.chars().count();
    if len >= width {
        value.to_string()
    } else {
        format!("{value}{}", " ".repeat(width - len))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_count_formats() {
        assert_eq!(format_token_count(100), "100");
        assert_eq!(format_token_count(128_000), "128K");
        assert_eq!(format_token_count(163_840), "163.8K");
        assert_eq!(format_token_count(1_310_720), "1.3M");
        assert_eq!(format_token_count(1_000_000), "1M");
        assert_eq!(format_token_count(4_000), "4K");
    }

    #[test]
    fn pad_end_pads_to_width() {
        assert_eq!(pad_end("yes", 6), "yes   ");
        assert_eq!(pad_end("images", 6), "images");
    }
}
