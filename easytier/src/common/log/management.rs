use std::sync::Arc;

use anyhow::Context as _;

use crate::common::config::LoggingConfigLoader;

use super::{EventObserver, FileSink, Logger, TargetFilter, install, parse_level};

pub fn init(config: impl LoggingConfigLoader, reload: bool) -> anyhow::Result<()> {
    init_with_default_console_targets(config, reload, &[super::LOG_TARGET])
}

pub fn init_with_default_console_targets(
    config: impl LoggingConfigLoader,
    reload: bool,
    default_targets: &[&str],
) -> anyhow::Result<()> {
    init_logger(config, reload, default_targets, None)
}

/// Installs the usual logger with an additional structured event destination.
///
/// The observer controls its own event selection. Console/file levels and
/// `RUST_LOG` continue to control only their existing output destinations.
pub fn init_with_event_observer(
    config: impl LoggingConfigLoader,
    reload: bool,
    default_targets: &[&str],
    observer: Arc<dyn EventObserver>,
) -> anyhow::Result<()> {
    init_logger(config, reload, default_targets, Some(observer))
}

fn init_logger(
    config: impl LoggingConfigLoader,
    reload: bool,
    default_targets: &[&str],
    observer: Option<Arc<dyn EventObserver>>,
) -> anyhow::Result<()> {
    let console_config = config.get_console_logger_config();
    let console_level = console_config
        .level
        .as_deref()
        .map(parse_level)
        .transpose()
        .context("invalid console log level")?;
    let console = TargetFilter::console_with_default_targets(console_level, default_targets)?;
    let file = FileSink::from_config(config.get_file_logger_config(), reload)?;

    let mut logger = Logger::new(console, file);
    if let Some(observer) = observer {
        logger = logger.with_event_observer(observer);
    }
    install(logger)
}
