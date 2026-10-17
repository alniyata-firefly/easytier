use easytier::core;

#[cfg(all(feature = "mimalloc", not(feature = "jemalloc")))]
use mimalloc::MiMalloc;

#[cfg(all(feature = "mimalloc", not(feature = "jemalloc")))]
#[global_allocator]
static GLOBAL_MIMALLOC: MiMalloc = MiMalloc;

#[cfg(feature = "jemalloc")]
#[global_allocator]
static ALLOC: jemallocator::Jemalloc = jemallocator::Jemalloc;

#[cfg(feature = "jemalloc-prof")]
#[allow(non_upper_case_globals)]
#[unsafe(export_name = "malloc_conf")]
pub static malloc_conf: &[u8] = b"prof:true,prof_active:true,lg_prof_sample:19,dirty_decay_ms:1000,muzzy_decay_ms:1000,retain:false\0";

#[cfg(not(feature = "jemalloc-prof"))]
#[allow(non_upper_case_globals)]
#[unsafe(export_name = "malloc_conf")]
pub static malloc_conf: &[u8] = b"dirty_decay_ms:1000,muzzy_decay_ms:1000,retain:false\0";

rust_i18n::i18n!("locales", fallback = "en");

fn main() -> std::process::ExitCode {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("Failed to create EasyTier runtime: {error}");
            return std::process::ExitCode::FAILURE;
        }
    };
    let exit = runtime.block_on(core::main());
    // Core has already completed its bounded graceful shutdown. Runtime::drop
    // would otherwise wait indefinitely for unrelated blocking host work.
    runtime.shutdown_timeout(std::time::Duration::from_secs(2));
    exit
}
