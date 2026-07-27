# Auto-Discovering Training Classes from a Demo Video — Research & Architecture Proposal

## 1. What you're actually describing

Stripped of UI details, the feature is a **cold-start dataset bootstrapper**: given a 2–3 minute demo recording and *no* trained model yet, automatically

1. sample frames from the video,
2. group visually-similar frames into "unique screens/actions" (unsupervised clustering — no labels exist yet),
3. propose a human-readable name for each group (auto-labeling),
4. let the user correct that (rename a class, merge two clusters that are really the same class), and
5. hand the resulting per-class image sets straight to the existing **Train a model** tab, which already expects exactly that shape of input (`ClassDraft { name, files[] }` in `train/page.tsx`).

That reframing matters because steps 1–5 map onto well-understood, separately-solved problems (video shot detection, image-embedding clustering, zero-shot image captioning, dataset curation UX) rather than one exotic thing — which is good news for buildability.

## 2. Market research — is anyone doing exactly this?

Nobody combines all five steps into one flow purpose-built for "bootstrap an image classifier's classes from my own app's demo video." But three adjacent categories are worth knowing about, because vid2log's version would sit in a real gap between them:

**a) Step-by-step documentation tools — Scribe, Tango, Guidde, Vidocu.** These record your clicks/keystrokes and auto-generate an annotated guide (screenshots + captions, or narrated video). Tango and Scribe are the "capture tools" camp (click-to-create, real-time recording); Guidde/Vidocu are the "video documentation" camp (adds AI voiceover). Closest in *spirit* (auto screen capture + AI-generated labels per step), but the output is a disposable, one-off document — there's no persistent taxonomy of "screen classes" and nothing is trained. Every run starts from zero.

**b) RPA process/task discovery — UiPath Task Capture & Task Mining.** This is the closest real analog. Task Capture "automatically detects and merges same-screen actions" from a recording and names each step via an LLM reading the screenshot + your narration; Task Mining goes further and clusters recordings *across many users* to find one representative common process. Conceptually this is steps 2–3 of your pipeline, already shipping in production. It's enterprise RPA tooling though — heavyweight, expensive, and the end product is an automation script, not a labeled image dataset for a downstream vision classifier.

**c) Dataset curation tooling — Roboflow, FiftyOne (Voxel51), fastdup.** These solve step 2 generically: embedding-based near-duplicate detection and clustering over an existing pile of images, plus active-learning-assisted labeling. fastdup in particular is built for exactly "which of these images are near-duplicates/semantic outliers" at scale. But they're generic dataset-curation platforms — you'd still have to build "extract frames from video" and "hand results to my trainer" yourself, and none of them are tuned for "frames from one continuous screen recording of one app."

**Conclusion:** the specific combination you're describing — single demo video → automatic screen/action taxonomy → editable → direct handoff into a classifier you already own — is a real, defensible feature. The building blocks all exist and are well-trodden; the packaging is what's missing from the market.

## 3. Proposed pipeline, stage by stage

### Stage A — Frame sampling
Nothing new needed: `video_pipeline.py`'s `_sample_and_classify` already does fps-based frame sampling via OpenCV (`cv2.VideoCapture`, `frame_interval = video_fps // fps`). Reuse that exact sampling loop, just without a classifier call — for a 2–3 min video at ~2 fps that's roughly 240–360 candidate frames.

### Stage B — (optional) coarse shot-boundary pre-filter
A tool like **PySceneDetect** (open source, content-aware / histogram-based cut detection) can collapse obviously-static stretches before the expensive step, cutting the number of frames that need embedding. Optional — the clustering step below can absorb this if you skip it, just at slightly higher compute cost.

### Stage C — Unique-screen discovery (the actual "auto-detect classes" step)
This is unsupervised clustering over frame **embeddings**, not raw pixels or file hashes — raw-pixel/perceptual-hash comparison is too brittle for real app screens (a moving cursor, a blinking caret, a ticking score counter, or an ad carousel will falsely look like "different screens" frame to frame).

- **Embedding model — three existing, ready-to-download options, no training required:**
  - **DINOv2** (Meta, self-supervised, `facebook/dinov2-base` on Hugging Face) — trained purely on images, no text pairing, and benchmarks show it produces *tighter, more separated* clusters than CLIP (V-measure 0.908 vs 0.719 for CLIP on one benchmark). Best default for pure visual-similarity clustering specifically.
  - **SigLIP** (Google, `google/siglip-so400m-patch14-384`) — a CLIP variant with a different loss function; a separate benchmark found it noticeably better than CLIP for *near-duplicate/duplicate* detection specifically (~59% vs ~33% precision). Slightly different sub-task than "semantic clustering" — worth it if de-duplication is the priority over grouping visually-different-but-same-class screens.
  - **CLIP** itself — the baseline everyone compares against; still fine, just outperformed by both of the above on the specific sub-tasks that matter here.
  - **Is Gemma (or a similar generative VLM) the right tool for this step? Not really.** Gemma 3, GPT-4V, and friends are generative language models that happen to *accept* images — they're not embedding models, so there's no clean, well-supported "give me a fixed vector for this image" API the way DINOv2/SigLIP/CLIP provide out of the box. You'd have to either (a) reach into internal hidden states, which for Gemma 3 specifically means extracting from its own SigLIP vision encoder — at which point you're better off just running SigLIP directly and skipping the multi-billion-parameter language model entirely — or (b) ask Gemma to *caption* every single frame and cluster the resulting text instead of the images, which costs one full generative call per frame (slow, and pushes 250–350 calls per video) and adds a layer of caption-quality noise into the clustering signal. Save the generative VLM for Stage D (naming the clusters, which is a handful of calls, not hundreds) and use a dedicated embedding model here.
  - **Domain-specific option worth knowing about, probably not usable here:** Screen2Vec (CHI 2021) is an academic embedding model built specifically for GUI screens — but it's trained on Android view-hierarchy + on-screen text + app metadata from the Rico dataset, not raw pixels. Since vid2log only has a video (no accessibility tree), this one isn't directly applicable, but the paper's finding — that layout + on-screen text meaningfully improves screen-similarity over pixels alone — is exactly why folding in the OCR text vid2log already extracts (mentioned below) is worth doing eventually.
  - **Practical note:** all three of DINOv2/SigLIP/CLIP load directly via Hugging Face `transformers` in a few lines of Python, run fine on CPU (slower) or any small GPU, output a fixed-size vector per frame, and feed straight into `hdbscan`/`scikit-learn` — no training or fine-tuning needed, no API key, no cost, and it slots naturally into the existing FastAPI/RQ-worker Python stack.
- **Clustering:** HDBSCAN over those embeddings — density-based, doesn't require pre-specifying the number of classes (you don't know how many "screens" exist ahead of time), and naturally buckets transitional/ambiguous frames as noise rather than forcing them into a cluster. A cheaper fallback if compute is tight: composite perceptual hash (pHash + dHash) with LSH bucketing and Union-Find — this is literally the technique used in recent GUI-agent research for exactly this kind of screenshot deduplication, at a fraction of the compute cost of embeddings, at some accuracy cost.
- **vid2log-specific bonus:** the hybrid classifier already runs OCR (Tesseract) as part of its CNN+OCR fusion philosophy. The same idea applies here — optionally blend OCR text similarity into the clustering signal, since "same layout, different score" and "same score, different layout" are exactly the kind of near-miss this project already knows how to reason about.

### Stage D — Auto-labeling each cluster
Pick 1–3 representative frames per cluster (e.g. the medoid, or frames nearest the cluster centroid) and ask a vision-language model to name it in a few words ("this is a screenshot from a screen-recorded app demo — name the screen/state/action in 2–4 words").

Three realistic tiers, cheapest/most private first:

| Option | Cost | Notes |
|---|---|---|
| **Florence-2** (Microsoft, MIT license, 0.23B–0.77B params) | Free, self-hosted | Purpose-built for captioning/grounding/detection in one small model; runs on CPU or a low-end GPU (T4-class). Good default — keeps the whole pipeline self-hosted like the rest of vid2log. |
| **Moondream2** (1.9B, open) | Free, self-hosted | Also tiny, explicitly designed for cheap image captioning + visual Q&A on modest hardware; slightly larger/better than Florence-2 in some cases. |
| **Gemma 3** (4B/12B/27B, open, Google) | Free, self-hosted (needs more VRAM at 4B+) | General-purpose multimodal LLM via a custom SigLIP vision encoder — heavier than the two above but higher-quality names/reasoning if you have the hardware. |
| **Gemini 2.5 Flash / Flash-Lite (hosted API)** | ~$0.30/M input tokens, batch API 50% off | Effectively fractions of a cent per image at this scale. Best label *quality* with zero self-hosting effort — reasonable as an optional "better names" toggle for users who don't mind a hosted call and a trivial per-video cost. |

Recommendation: **default to a small self-hosted model (Florence-2 or Moondream2)** to match how the rest of vid2log is architected (everything else — the CNN, OCR, training — runs on your own worker, nothing is sent to a third-party API), and offer the Gemini route as an opt-in upgrade, not a dependency.

(For reference, if you ever want *element-level* grounding — "here's the exact button coordinates" rather than "this is the settings screen" — that's what OmniParser/UI-TARS/SeeClick-class models are for. That's a different, heavier problem than what's needed here; worth knowing the terminology exists, not worth building against for v1.)

### Stage E — Human-in-the-loop review UI (rename + merge)
This is pure frontend work and maps directly onto patterns already in this codebase:

- New "Discover classes from video" flow: upload video → job runs stages A–D → results screen shows one card per cluster: an editable name field, a thumbnail strip of its member frames, and a checkbox.
- Reuse the **`JobSelectList`-style shift-click/checkbox multi-select** you already built for the Analytics page to let a user select 2+ cluster cards and hit "Merge selected" — merges their frame sets under one name.
- "Send to Train" converts each surviving cluster into one `ClassDraft` object (`{ id: newId(), name: cluster.name, files: framesAsFiles }`) and drops the user straight into the **existing** Train tab, pre-populated. Almost none of the actual training code changes — this is the same reason the rest of vid2log already works.

### Stage F — Per-class frame subsampling
Don't hand every member frame of a cluster to training — a cluster from a 3-minute static screen could have 60+ near-identical frames, which both wastes upload bandwidth and defeats the "~20–25 example images per class" guidance already on the Train page. Subsample for diversity (farthest-point sampling in embedding space, or simple even-interval sampling) capped around 25–40 images per class before export.

## 4. Suggested phasing

- **MVP:** reuse existing OpenCV frame sampling → SigLIP/CLIP embeddings → HDBSCAN → Florence-2 or Moondream2 for cluster names → new rename/merge review UI → hand off into the existing `ClassDraft`/Train flow. Fully self-hosted, no new paid dependency, consistent with how the rest of the app is built.
- **v1.5:** optional "use a hosted model for nicer names" toggle (Gemini Flash), a few cents per video.
- **v2 (stretch):** fold OCR text similarity into the clustering signal alongside visual embeddings, same fusion instinct already used in the hybrid classifier.

## 5. Honest risks to test before committing

- Real app demo videos have things that *aren't* the pixels of "the screen" but still vary a lot frame-to-frame — animated backgrounds, live counters, moving cursors, video ad carousels. Embedding-based clustering handles this far better than raw hashing, but it can still **over-segment** a genuinely-single screen into 2–3 clusters if it's visually dynamic enough. Budget for a "merge" UI from day one (which you're already planning) rather than expecting clustering to get it perfectly right unsupervised.
- Cluster counts will vary a lot by app; there's no universal "right" number of clusters to target — HDBSCAN's density-based approach avoids needing to guess this in advance, which is why it's the recommended default over k-means.
- Worth a small pilot on 2–3 of your own real demo videos before deciding this graduates from "nice idea" to "build it" — the actual over/under-segmentation behavior on your specific kind of app content is the one thing that can't be fully predicted from research alone.

## Sources

- [CLIP Vs DINOv2 in image similarity](https://medium.com/aimonks/clip-vs-dinov2-in-image-similarity-6fa5aa7ed8c6)
- [Finding the Best Embedding Model for Image Classification — Voxel51](https://voxel51.com/blog/finding-the-best-embedding-model-for-image-classification)
- [SigLIP 2 vs DINOv2: Battle of the embeddings titans](https://underfitted.dev/2026/03/01/siglip-2-vs-dinov2-battle-of-the-embeddings-titans/)
- [Screen2Vec: Semantic Embedding of GUI Screens and GUI Components (arXiv)](https://arxiv.org/pdf/2101.11103)
- [Screen2Vec — GitHub](https://github.com/tobyli/Screen2Vec)

- [Automated Step-by-Step Guide Creation: Scribe vs Tango vs Alternative Solutions](https://www.guidde.com/blog/automated-step-by-step-guide-creation-scribe-vs-tango-vs-alternative-solutions)
- [Scribe vs Tango: Process Documentation Tool Review](https://scribe.com/library/scribe-vs-tango)
- [Task Capture — Process Discovery Tool | UiPath](https://www.uipath.com/product/task-capture)
- [Task Mining — Capturing with the recorder | UiPath docs](https://docs.uipath.com/task-mining/automation-cloud/latest/user-guide/capture-a-trace-with-the-recorder-atm)
- [Task Mining — Task Capture integration | UiPath docs](https://docs.uipath.com/task-mining/automation-suite/2023.10/user-guide/task-capture-integration)
- [fastdup: The Revolutionary Image Dataset Cleaner ML Teams Need](https://www.blog.brightcoding.dev/2026/06/29/fastdup-the-revolutionary-image-dataset-cleaner-ml-teams-need)
- [Exploring Your Visual Dataset with Embeddings in FiftyOne](https://odsc.medium.com/exploring-your-visual-dataset-with-embeddings-in-fiftyone-7e584c81edcd)
- [What is Active Learning? The Ultimate Guide — Roboflow](https://blog.roboflow.com/what-is-active-learning/)
- [Deduplication of Videos Using Fingerprints, CLIP Embeddings](https://dzone.com/articles/deduplication-of-videos-using-fingerprints-clip-embeddings)
- [Comparative Evaluation of Perceptual Hashing and Deep Embedding Methods for Robust and Efficient Image Deduplication](https://www.mdpi.com/2079-9292/15/7/1493)
- [UI-Oceanus: Scaling GUI Agents with Synthetic Environmental Dynamics (arXiv)](https://arxiv.org/pdf/2604.02345)
- [Gemma explained: What's new in Gemma 3 — Google Developers Blog](https://developers.googleblog.com/gemma-explained-whats-new-in-gemma-3/)
- [Gemma 3: Multimodal and Vision Analysis — Roboflow](https://blog.roboflow.com/gemma-3/)
- [Gemma 3 Technical Report (arXiv)](https://arxiv.org/pdf/2503.19786)
- [vikhyatk/moondream2 — Hugging Face](https://huggingface.co/vikhyatk/moondream2)
- [Florence-2: Vision-language Model — Roboflow](https://blog.roboflow.com/florence-2/)
- [Florence-2: Advancing Multiple Vision Tasks with a Single VLM Model](https://towardsdatascience.com/florence-2-mastering-multiple-vision-tasks-with-a-single-vlm-model-435d251976d0/)
- [Gemini Developer API pricing | Google AI for Developers](https://ai.google.dev/gemini-api/docs/pricing)
- [Gemini 2.5 Flash API Pricing 2026](https://pricepertoken.com/pricing-page/model/google-gemini-2.5-flash)
- [OmniParser for Pure Vision Based GUI Agent (arXiv)](https://arxiv.org/pdf/2408.00203)
- [OmniParser — Microsoft GitHub](https://github.com/microsoft/OmniParser)
- [UI-TARS: Pioneering Automated GUI Interaction with Native Agents (arXiv)](https://arxiv.org/pdf/2501.12326)
- [HeyClicky — Y Combinator company page](https://www.ycombinator.com/companies/heyclicky)
- [heyclicky.com](https://www.heyclicky.com/)
