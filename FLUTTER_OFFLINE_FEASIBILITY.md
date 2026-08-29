# vid2log as an offline Flutter desktop app (Windows + macOS) — feasibility & build plan

## Verdict up front

Feasible, but it is a genuine multi-month systems-engineering project, not a UI port. Nothing about Flutter itself is the problem — Flutter's Windows/macOS desktop support is mature and production-ready. The real work is replacing every piece of vid2log that currently runs as Python on a server (TensorFlow CNN classification, Tesseract OCR, a scikit-learn text classifier, DINOv2 + HDBSCAN action discovery, SPM/DSM pattern mining, and the training pipeline) with something that runs entirely inside a Dart/Flutter desktop process, with no network calls at all.

Of everything in that list, one piece is meaningfully higher-risk than the rest (DINOv2 + HDBSCAN action discovery — no mature on-device path exists today) and one piece is the biggest unknown (on-device model *training*, not just inference — the tooling exists but nobody has wired it into Dart yet). Everything else — CNN inference, OCR, video frame sampling, the text classifier, pattern mining, local storage — has mature, well-supported tools and is comparatively low-risk. The plan below is structured to spike those two uncertain pieces first, before committing engineering time to the full build, since they're what actually determines whether this is a 4-month project or something longer.

## The core architectural decision: don't depend on Dart ML-library maturity — bundle native binaries and shell out

This is the single most important risk-reduction call in this whole plan, so it's worth stating up front rather than burying it in a section below.

The current Python backend doesn't actually use exotic ML integrations for OCR or video decoding — `pytesseract` is a thin wrapper that shells out to the system `tesseract` binary, and video frame extraction goes through OpenCV, which itself wraps FFmpeg-class decoding. Both `tesseract` and `ffmpeg` ship official, mature, prebuilt binaries for both Windows and macOS. Rather than betting on the maturity of a Dart/Flutter *binding* for either of these (the Tesseract Flutter plugins that exist compile Tesseract from source per-platform, which is a real build-fragility risk; a decent Dart OpenCV binding exists but its desktop maturity is less certain), the lower-risk path is: bundle the official `tesseract` and `ffmpeg` executables inside the app's install directory, and call them via Dart's `Process.run()` — exactly the same "shell out to a real binary" pattern the current Python backend already uses, just without Python in between. This sidesteps an entire category of "is this Flutter package actually production-ready" risk for two of the app's dependencies.

The same instinct — prefer a mature native binary + FFI/subprocess over a young Flutter-specific binding — should apply throughout this plan wherever there's a choice.

## Piece-by-piece: what needs to be rebuilt, and how

**CNN scene classifier (currently: TensorFlow/tf-keras, MobileNetV2 transfer learning, frozen backbone).** Convert trained models from Keras `.h5` to ONNX (via `tf2onnx`, a standard, low-risk one-time conversion step) and run inference through **ONNX Runtime**, which has real Flutter packages (`onnxruntime`, `flutter_onnxruntime`, `fonnx`) with explicit Windows and macOS desktop support. Low risk — this is a well-trodden path with lots of prior art.

**On-device training (the actual training pipeline, not just inference).** This is the biggest open question in the whole plan. ONNX Runtime has a real "On-Device Training" API — it's a genuine, documented Microsoft feature, built for exactly this kind of scenario (a frozen backbone with a small trainable head, i.e. transfer learning / personalization), and it officially supports Windows, macOS, and Linux. The catch: none of the existing Flutter ONNX packages found expose the *training* API — they're inference-only. Getting this working means writing custom Dart FFI bindings directly against ONNX Runtime's C training API yourself. That's a real, scoped, doable piece of systems programming, but it's unproven for this exact combination and should be the very first thing prototyped, before any UI work starts. One piece of good news that meaningfully de-risks this: the existing backend's own README documents that this exact workload (frozen MobileNetV2 + small head, ~20–25 images/class) already trains in under a minute on plain CPU — so the *computational* cost of on-device training was never the concern; the concern is purely the Dart↔ONNX-Runtime-Training integration work.

**OCR (currently: Tesseract via `pytesseract`).** Bundle the official `tesseract` binary per-OS and shell out via `Process.run()`, per the architectural decision above. Low risk — Tesseract itself is mature and cross-platform; the risk was only ever in relying on a Flutter binding that compiles it from source.

**Text classifier (currently: TF-IDF + Logistic Regression via scikit-learn).** This one is small enough to be worth reimplementing natively in Dart rather than exporting/running a model at all — TF-IDF vectorization and a linear logistic-regression classifier are both just arithmetic, with no exotic dependencies. Low risk, and it removes a dependency rather than adding one.

**CNN+OCR fusion logic (keyword rules → trained text classifier → CNN fallback).** Pure application logic, no ML framework involved — a straightforward, low-risk port of the existing three-tier decision logic.

**Video frame sampling.** Bundle `ffmpeg` and shell out to it (same pattern as Tesseract), rather than depending on a Dart video-decoding library's maturity. Low risk.

**Action discovery (currently: DINOv2 embeddings via PyTorch + HDBSCAN clustering).** This is the highest-risk piece in the whole port, for two separate reasons that stack:

- DINOv2 itself is exportable to ONNX (community prior art exists for this) and can then run through the same ONNX Runtime path as the CNN classifier — feasible, though a full vision transformer will run noticeably slower on a laptop CPU than it does on server infrastructure today. The existing app already only runs its equivalent OCR step on detected scene *changes* rather than every frame; the same trick (embed only on candidate transitions, not every sampled frame) should carry over here and matters a lot for making this tolerable on-device.
- HDBSCAN has **no mature Dart implementation** — confirmed by research, not an assumption. A plain DBSCAN package does exist for Dart (density-based, also doesn't require specifying cluster count up front, which is the property that made HDBSCAN attractive here in the first place), and is the pragmatic substitute to prototype with first. Whether DBSCAN's clustering quality is "good enough" compared to HDBSCAN's variable-density robustness is genuinely unknown until tested on real sample recordings — this is exactly the kind of thing to spike early rather than discover during a UI-polish phase. If DBSCAN's output quality turns out to be insufficient, the fallback is porting HDBSCAN's algorithm to Dart directly (a real but bounded engineering effort — it's a well-published algorithm, not a black box) or FFI-binding the existing compiled HDBSCAN C/Cython library (nobody has done this for Dart yet, so it'd be first-mover work).

**Pattern mining (SPM/DSM).** Pure algorithmic Python (gap/window-constrained sequential pattern mining, plus SciPy statistical significance tests for DSM) with zero ML dependency — a clean, low-risk, straightforward reimplementation in Dart. The only nuance: Dart has no SciPy-equivalent statistics library, so the specific statistical tests DSM uses need to be hand-implemented from their formulas (well-defined, bounded work, not a research problem) rather than imported off the shelf.

**Auth, roles, multi-user access.** This entire layer — Firebase Auth, Firestore-backed user roles, the admin dashboard, user management — doesn't apply to a single-user local desktop tool and should simply be dropped, not ported. That's a real scope *reduction* worth banking, not a challenge to solve.

**Storage.** Replace Firestore (job/model/dataset metadata) and Cloud Storage (video/image blobs, trained model files) with a local SQLite database (via a mature Dart package like `drift` or `sqlite3`) and the local filesystem. Standard, low-risk desktop-app territory.

**Job queue (Redis + RQ).** Not needed at all for a single local app — replace with Dart **isolates**, Flutter's built-in mechanism for running heavy work off the UI thread. This is the idiomatic Flutter answer to "background processing" and is low risk.

## Real challenges beyond the ML porting itself

**App size.** Bundling ONNX Runtime's native libraries, the Tesseract binary, the FFmpeg binary, a CNN model, and a DINOv2 ONNX model together will likely push the installed app into the hundreds-of-MB range, possibly over a gigabyte. Not a blocker, but a real download/install-size consideration if this is meant for casual download rather than an internal engineering tool.

**Building native dependencies for two OSes.** Tesseract, FFmpeg, and ONNX Runtime's native libraries generally need to actually be built/tested on each target OS — you can't reliably cross-compile a macOS binary from a Windows machine or vice versa. In practice this means either owning both a Windows machine and a Mac, or (the standard, recommended solution) a CI matrix — GitHub Actions natively supports both `windows-latest` and `macos-latest` runners, which is the realistic way to produce and test both builds without owning both machines yourself.

**Apple Silicon vs. Intel.** A macOS release needs to target both `arm64` and `x86_64` (either as a universal binary or as two separate builds), which multiplies the native-dependency-bundling work already described above.

**Code signing and notarization.** macOS will show Gatekeeper warnings (or refuse to open the app at all, depending on how it's distributed) without Apple notarization, which requires an Apple Developer account (~$99/year) and a notarization step in the release process. Windows doesn't strictly require code signing to run, but an unsigned `.exe` will trigger SmartScreen warnings that look alarming to end users — a code-signing certificate is the practical fix. This is a real launch-readiness cost, not a technical risk, but it's easy to underestimate if you haven't shipped a signed desktop app before.

**CPU-only inference/training speed.** Everything runs on the end user's own hardware now, with no server GPU to fall back on. MobileNetV2 head training is already proven fast on CPU (see above). DINOv2 inference is the one place this could feel slow on lower-end laptops — ONNX Runtime does have CoreML (Mac) and DirectML (Windows) execution providers that can meaningfully accelerate this using the device's GPU/Neural Engine, which is worth building toward but isn't required for a first working version.

## Phased plan

**Phase 0 — Spikes (1–2 weeks), before any UI work.** Answer the three genuinely uncertain questions first, cheaply, in isolation:
1. Can a small ONNX model actually be trained end-to-end from Dart via custom FFI bindings to ONNX Runtime's on-device training API, on both Windows and macOS? This is the single most important spike — if it doesn't pan out cleanly, the fallback (below) needs to be decided before Phase 2 is scoped.
2. Does bundling `tesseract` + `ffmpeg` binaries and shelling out to them actually work cleanly, packaged, on both target OSes?
3. On a handful of real sample recordings, how does plain DBSCAN clustering quality compare to the existing HDBSCAN output? This determines whether action discovery ships as-is or needs the fallback described above.

If spike #1 doesn't work out cleanly on a reasonable timeline, the fallback worth having ready is: bundle a real embedded Python runtime (via an approach like `serious_python`, or a PyInstaller/Nuitka-packaged sidecar process that the Flutter app spawns and talks to over localhost or gRPC) running the *existing* training pipeline unmodified. This still satisfies "no external backend, works offline" — the Python process runs entirely on the user's own machine with no network calls — it just isn't a from-scratch Dart reimplementation. It's a legitimate, well-precedented pattern (several production Flutter desktop apps ship this way), and worth deciding on up front as Plan B rather than discovering mid-project that pure-Dart on-device training isn't practical.

**Phase 1 — Core offline inference pipeline (4–6 weeks).** Video frame sampling via bundled FFmpeg, CNN inference via ONNX Runtime (existing `.h5` models converted to ONNX), OCR via bundled Tesseract, the text classifier and fusion logic reimplemented natively in Dart, local SQLite storage for jobs and logs, CSV export. This alone reproduces "process a video with an existing/bundled model and get a log out" fully offline.

**Phase 2 — On-device training (3–5 weeks).** Builds directly on the Phase 0 spike outcome — either the custom ONNX Runtime Training FFI path, or the embedded-Python fallback. UI for adding training images per action, the real train/val/test split and metrics reporting (porting the existing metric logic), a local model registry.

**Phase 3 — Action discovery + pattern mining (3–4 weeks).** DINOv2 ONNX export and on-device inference, clustering (DBSCAN or the HDBSCAN port/FFI-binding, depending on the Phase 0 quality comparison), SPM/DSM reimplemented natively in Dart.

**Phase 4 — Polish and packaging (2–3 weeks).** Port of the existing design system to Flutter widgets, installers (MSIX or a plain signed `.exe` for Windows; a notarized `.dmg`/`.app` for macOS), a CI build matrix (GitHub Actions `windows-latest` + `macos-latest`), and — optional but worth scoping — an auto-update mechanism.

**Realistic total: roughly 4–5 months for one strong engineer already comfortable with Flutter and willing to write Dart FFI bindings**, assuming Phase 0's spikes land on the optimistic path. If the on-device training spike forces the embedded-Python fallback, add time for packaging a full Python runtime per OS, but *subtract* the custom-FFI-training engineering effort — it roughly nets out, just shifts the risk from "novel integration work" to "cross-platform Python packaging," which is a better-understood problem with more prior art (see the `serious_python` / PyInstaller-sidecar precedent above).

## What I'd do first, concretely

Before writing any Flutter UI code at all: stand up a bare-bones Dart command-line project (no UI) and get all three Phase 0 spikes working end-to-end against real vid2log data — an existing trained model doing ONNX inference, an actual small training run via ONNX Runtime Training's C API through hand-written FFI bindings, and a DBSCAN clustering pass on a real sample video compared side-by-side against the current Python backend's HDBSCAN output. That's roughly a one-to-two-week investment that tells you, with real evidence instead of guesswork, whether Phase 2 and Phase 3 above are actually as scoped or whether Plan B (embedded Python) is the right call from day one.
