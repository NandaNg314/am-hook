//! Persistent worker pool for parallel sample decryption (pure std).
//!
//! `decrypt_par` used to spawn `available_parallelism` OS threads on
//! every call (`std::thread::scope`), costing ~0.7-1 ms per call in thread
//! creation alone (measured on WSL). This module replaces that with a pool of
//! long-lived worker threads that are reused across calls (epoch-based job
//! dispatch), eliminating the per-call spawn cost entirely.
//!
//! Design:
//!   * Workers sleep on a condvar until a new job epoch is published.
//!   * Each worker pulls work from a shared atomic counter, so a job is
//!     processed by all workers in parallel; each index is handled by exactly
//!     one worker.
//!   * The caller blocks until `pending == 0` (a completion flag + condvar),
//!     which also guarantees the borrowed input/output pointers stay valid
//!     for the whole call — this is what makes the raw-pointer job sound.
//!
//! Concurrency: the pool is process-global and dispatches one job at a time,
//! so concurrent `par_decrypt_into` callers serialize on the pool (each call
//! is internally parallel). This matches the hot-path usage (one caller
//! batches thousands of samples per call).

use crate::rounds::Template;
use std::slice;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 一次 `run()` 最长等待时间；超过后先让 worker 排空，仍然完不成就报错而不是永久阻塞
const RUN_TIMEOUT: Duration = Duration::from_secs(60);
/// 超时后给 worker 排空的宽限期
const DRAIN_GRACE: Duration = Duration::from_secs(5);

struct Job {
    tmpl: *const Template,
    ptrs: *const *const u8,
    lens: *const usize,
    offs: *const usize,
    n: usize,      // number of samples
    pairs: usize,  // number of 2-lane work items (ceil(n/2))
    next: AtomicUsize,
    pending: AtomicUsize,
    finished: AtomicBool,
    /// 有 worker 在处理体里 panic（或等待超时），结果不可信
    failed: AtomicBool,
    out: *mut u8,
}
// SAFETY: `run()` blocks until `finished`, so `tmpl`/`ptrs`/`lens`/`offs`/`out`
// remain valid for the whole call. Each index i is processed by exactly one
// worker and writes a disjoint output region, so the shared `Job` is sound.
unsafe impl Send for Job {}
unsafe impl Sync for Job {}

struct Shared {
    job: Mutex<Option<(Arc<Job>, u64)>>,
    cv_job: Condvar,
    shutdown: AtomicBool,
    epoch: AtomicUsize,
    done_mutex: Mutex<()>,
    cv_done: Condvar,
    // serializes concurrent run() calls: the pool has one job slot, so a
    // second concurrent call would overwrite the first's job and deadlock it.
    // Concurrent callers queue here (each call is internally parallel).
    run_lock: Mutex<()>,
}

struct Pool {
    shared: Arc<Shared>,
    threads: Vec<std::thread::JoinHandle<()>>,
}

impl Drop for Pool {
    /// Signal shutdown, wake all workers, and join them. Only runs when a
    /// Pool is dropped directly (the process-global `POOL` OnceLock never
    /// drops, so library users get process-lifetime workers — the intended
    /// hot-path behaviour).
    fn drop(&mut self) {
        self.shared.shutdown.store(true, Ordering::Release);
        self.shared.cv_job.notify_all();
        for t in self.threads.drain(..) {
            let _ = t.join();
        }
    }
}

impl Pool {
    fn new(workers: usize) -> Pool {
        let shared = Arc::new(Shared {
            job: Mutex::new(None),
            cv_job: Condvar::new(),
            shutdown: AtomicBool::new(false),
            epoch: AtomicUsize::new(0),
            done_mutex: Mutex::new(()),
            cv_done: Condvar::new(),
            run_lock: Mutex::new(()),
        });
        let mut threads = Vec::with_capacity(workers);
        for _ in 0..workers {
            let s = shared.clone();
            threads.push(std::thread::spawn(move || worker_loop(s)));
        }
        Pool { shared, threads }
    }

    fn run(
        &self,
        tmpl: &Template,
        ptrs: &[*const u8],
        lens: &[usize],
        offs: &[usize],
        out: &mut [u8],
    ) -> Result<(), String> {
        let n = lens.len();
        if n == 0 {
            return Ok(());
        }
        let pairs = (n + 1) / 2;
        // serialize with other concurrent run() calls (single job slot)
        let _run_guard = self.shared.run_lock.lock().unwrap_or_else(|e| e.into_inner());
        let job = Arc::new(Job {
            tmpl,
            ptrs: ptrs.as_ptr(),
            lens: lens.as_ptr(),
            offs: offs.as_ptr(),
            n,
            pairs,
            next: AtomicUsize::new(0),
            pending: AtomicUsize::new(pairs),
            finished: AtomicBool::new(false),
            failed: AtomicBool::new(false),
            out: out.as_mut_ptr(),
        });
        let epoch = self.shared.epoch.fetch_add(1, Ordering::Relaxed) as u64 + 1;
        {
            let mut g = self.shared.job.lock().unwrap_or_else(|e| e.into_inner());
            *g = Some((job.clone(), epoch));
        }
        self.shared.cv_job.notify_all();

        let mut g = self.shared.done_mutex.lock().unwrap_or_else(|e| e.into_inner());
        let deadline = Instant::now() + RUN_TIMEOUT;
        while !job.finished.load(Ordering::Acquire) {
            let Some(left) = deadline.checked_duration_since(Instant::now()) else {
                break;
            };
            let (guard, _) = self.shared.cv_done.wait_timeout(g, left).unwrap_or_else(|e| e.into_inner());
            g = guard;
        }
        // 超时：先让 worker 停止领新工作并排空 pending，再给一小段宽限期。
        // 这里不能直接返回 —— 缓冲区仍被 worker 借用，提前解引用会造成 use-after-free。
        if !job.finished.load(Ordering::Acquire) {
            job.failed.store(true, Ordering::Release);
            let grace = Instant::now() + DRAIN_GRACE;
            while !job.finished.load(Ordering::Acquire) {
                let Some(left) = grace.checked_duration_since(Instant::now()) else { break };
                let (guard, _) = self.shared.cv_done.wait_timeout(g, left).unwrap_or_else(|e| e.into_inner());
                g = guard;
            }
        }
        drop(g);
        if !job.finished.load(Ordering::Acquire) {
            // 只有 worker 线程被外力杀死（栈溢出 abort / 进程即将退出）才会走到这里
            return Err(format!("temari: decryption pool stalled (>{}s)", RUN_TIMEOUT.as_secs() + DRAIN_GRACE.as_secs()));
        }
        if job.failed.load(Ordering::Acquire) {
            return Err("temari: a decryption worker panicked".into());
        }
        Ok(())
    }
}

fn worker_loop(shared: Arc<Shared>) {
    let mut my_epoch = 0u64;
    loop {
        let job = {
            let mut g = shared.job.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                if let Some((j, e)) = g.as_ref() {
                    if *e != my_epoch {
                        break j.clone();
                    }
                }
                if shared.shutdown.load(Ordering::Acquire) {
                    return;
                }
                g = shared.cv_job.wait(g).unwrap_or_else(|e| e.into_inner());
            }
        };
        my_epoch += 1;
        loop {
            let p = job.next.fetch_add(1, Ordering::Relaxed);
            if p >= job.pairs {
                break;
            }
            if job.failed.load(Ordering::Acquire) {
                // 已经失败：只把剩余工作项的 pending 清零，保证 run() 一定能返回
                complete_item(&job, &shared);
                continue;
            }
            // 处理体里 panic 不能让 pending 永远不归零（会拖死 run() 并永久占住 run_lock）
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| process_pair(&job, p)));
            if outcome.is_err() {
                job.failed.store(true, Ordering::Release);
            }
            complete_item(&job, &shared);
        }
    }
}

/// 一个工作项完成（或失败跳过）：把 pending 减一，减到 0 时通知 run()
fn complete_item(job: &Job, shared: &Shared) {
    if job.pending.fetch_sub(1, Ordering::AcqRel) == 1 {
        job.finished.store(true, Ordering::Release);
        shared.cv_done.notify_all();
    }
}

fn process_pair(job: &Job, p: usize) {
    #[cfg(test)]
    if INJECT_PANIC.swap(false, Ordering::SeqCst) {
        panic!("injected worker panic (test)");
    }
    // SAFETY: run() blocks until finished; ptrs/lens/offs/out/tmpl
    // live for the whole call; each pair (2i, 2i+1) is owned by
    // exactly one worker and writes disjoint output regions.
    let i1 = p * 2;
    let (ptr1, len1, off1) = unsafe {
        (*job.ptrs.add(i1), *job.lens.add(i1), *job.offs.add(i1))
    };
    let sample1 = unsafe { slice::from_raw_parts(ptr1, len1) };
    let out1 = unsafe { slice::from_raw_parts_mut(job.out.add(off1), len1) };
    let tmpl = unsafe { &*job.tmpl };
    let i2 = i1 + 1;
    if i2 < job.n {
        let (ptr2, len2, off2) = unsafe {
            (*job.ptrs.add(i2), *job.lens.add(i2), *job.offs.add(i2))
        };
        let sample2 = unsafe { slice::from_raw_parts(ptr2, len2) };
        let out2 = unsafe { slice::from_raw_parts_mut(job.out.add(off2), len2) };
        crate::rounds::decrypt_region_pair_into(tmpl, sample1, sample2, out1, out2);
    } else {
        crate::rounds::decrypt_region_into(tmpl, sample1, out1);
    }
}

#[cfg(test)]
static INJECT_PANIC: AtomicBool = AtomicBool::new(false);

static POOL: OnceLock<Pool> = OnceLock::new();

fn pool() -> &'static Pool {
    POOL.get_or_init(|| {
        let workers = std::env::var("TEMARI_WORKERS")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|&w| w > 0)
            .unwrap_or_else(|| {
                std::thread::available_parallelism().map(|p| p.get()).unwrap_or(4)
            });
        Pool::new(workers)
    })
}

/// Decrypt `samples` in parallel, writing each plaintext into `out` at the
/// offset given by `offs[i]` (each region is exactly `len == samples[i].len()`).
/// Caller must ensure `out.len() >= offs[n-1] + lens[n-1]`.
pub(crate) fn par_decrypt_into(
    tmpl: &Template,
    samples: &[&[u8]],
    offs: &[usize],
    out: &mut [u8],
) {
    let n = samples.len();
    if n == 0 {
        return;
    }
    if n == 1 {
        crate::rounds::decrypt_region_into(tmpl, samples[0], &mut out[offs[0]..offs[0] + samples[0].len()]);
        return;
    }
    // build raw pointer + lens arrays (the job can't hold `&[u8]` refs)
    let ptrs: Vec<*const u8> = samples.iter().map(|s| s.as_ptr()).collect();
    let lens: Vec<usize> = samples.iter().map(|s| s.len()).collect();
    // 对外 API（rounds / am-mp4 / ffi）签名固定为不返回错误：worker 失败时以 panic
    // 把问题抛给上层（服务的 spawn_blocking 会把它变成 JoinError -> 明确错误码），
    // 而不是静默返回半截明文或永久阻塞。
    if let Err(error) = pool().run(tmpl, &ptrs, &lens, offs, out) {
        panic!("{error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rounds::R1Entry;

    #[test]
    fn test_worker_panic_returns_error_instead_of_hanging() {
        let pool = Pool::new(2);
        let tmpl = Template::new(vec![0u8; 0x8000], [0u32; 2048], R1Entry { rdx: 0, rcx: 0, rax: 0, r9: 0, rbp: 0 });
        let samples: Vec<&[u8]> = vec![&[0u8; 32], &[0u8; 32]];
        let ptrs: Vec<*const u8> = samples.iter().map(|s| s.as_ptr()).collect();
        let lens: Vec<usize> = samples.iter().map(|s| s.len()).collect();
        let offs = vec![0usize, 32usize];

        let mut out = vec![0u8; 64];
        INJECT_PANIC.store(true, Ordering::SeqCst);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| pool.run(&tmpl, &ptrs, &lens, &offs, &mut out)));
        let failed = match result {
            Ok(inner) => inner.is_err(),
            Err(_) => true,
        };
        assert!(failed, "worker panic must surface as an error, not a hang");

        // run_lock 没有被 panic 永久占住，池子还能继续工作
        let mut out2 = vec![0u8; 64];
        assert!(pool.run(&tmpl, &ptrs, &lens, &offs, &mut out2).is_ok());
    }

    #[test]
    fn test_empty_batch_is_ok() {
        let pool = Pool::new(1);
        let tmpl = Template::new(vec![0u8; 0x8000], [0u32; 2048], R1Entry { rdx: 0, rcx: 0, rax: 0, r9: 0, rbp: 0 });
        assert!(pool.run(&tmpl, &[], &[], &[], &mut []).is_ok());
    }
}