# Why the generated log flickers, and how to fix it

Comparing `Model_Generated_3 Kumud 1 Kumud w et_analysis.csv` against your manually corrected `Corrected_3 Kumud 1 Kumud w et.csv` for the same video.

## 1. What the numbers show

| | Model-generated | Your correction |
|---|---|---|
| Segments (over the same ~31 min) | 429 | 101 |
| Median segment length | ~2s | 13s |
| Segments shorter than 2s | 56% | 1% |
| Segments shorter than 5s | 80% | 16% |

The model isn't randomly wrong — it's specifically flickering. Of the 428 transitions in the model's output, **325 (76%) are `GameWorkspace ↔ ProductPlacement` flipping back and forth**, often for a second or two at a time, exactly where your correction just has one long `4 Game_Space` segment with occasional short `5 Prod_Place` moments. Average confidence on both classes sits at 0.57–0.60 — right at the noise floor, not a confident call either way. 36% of all segments came from the OCR-fusion path, and a lot of those fusion confidences are in the 0.3–0.5 range too, meaning OCR isn't resolving the ambiguity, it's largely along for the ride.

## 2. Root cause

Two separate problems are stacked on top of each other:

**A. No temporal smoothing in the pipeline.** Looking at `_sample_and_classify()` in `backend/app/services/video_pipeline.py`: every single sampled frame (2fps by default) where the CNN's top-1 label differs from the current scene's class immediately triggers a candidate transition, verified once by `verify_transition()` in `hybrid_classifier.py`, and committed if it disagrees. There's no requirement that a new class be confirmed by more than one frame, no minimum confidence to actually switch, and no minimum dwell time. A classifier whose confidence on two classes is close (which is expected near a real class boundary) will flip the argmax almost every frame — and every flip becomes a scene in your log.

**B. `ProductPlacement` and `GameWorkspace` are genuinely hard for the CNN to tell apart.** Placing a product happens inside the game workspace, so the two screens look nearly identical apart from a small cursor/ghost-icon UI element. That's a real classification-difficulty problem, not just a smoothing problem — no amount of temporal filtering fully fixes a class boundary the model can't reliably see frame-to-frame. Smoothing will hide the flicker in the output log, but the underlying frame-level confusion is worth addressing too.

## 3. What's established practice for this (research)

This exact shape of problem — a per-frame classifier over a video producing a "workflow phase" sequence that needs to be a clean, stable timeline — is a known one in the video-classification literature, most directly in surgical/industrial "workflow recognition" work (e.g. the M2CAI Workflow Challenge line of research, which pairs a per-frame CNN with time-smoothing and an HMM specifically to turn noisy per-frame predictions into a clean phase timeline). The standard toolbox, roughly cheapest → most thorough:

- **Majority-vote / mode filtering** over a sliding window of recent frame labels — replace the raw per-frame label with whatever label was most common in the last N frames.
- **Hysteresis / minimum-dwell debounce** — don't accept a class change until the new class has been the top prediction for several consecutive frames (used broadly in streaming/online action detection to avoid single-frame flicker).
- **Exponential moving average (EMA) on the softmax probabilities**, not just the label — smooth the probability vector across frames, then argmax the smoothed vector. This is gentler than hard majority-vote and reacts faster to real changes.
- **HMM + Viterbi decoding** over the whole per-frame probability sequence, with a transition penalty — finds the globally-optimal smooth segmentation instead of committing greedily frame-by-frame. This is literally what the CNN+time-smoothing+HMM papers above do for the analogous "recognize workflow phase from video" problem.
- **Post-hoc despiking** — after scenes are built, merge any scene shorter than some threshold into its neighbor (especially A→B→A patterns where B is a blip).

Sources: [M2CAI Workflow Challenge: CNNs with Time Smoothing and HMM for Video Frame Classification](https://arxiv.org/pdf/1610.05541), [Real-time Online Video Detection with Temporal Smoothing Transformers](https://arxiv.org/abs/2209.09236), [Adaptive Exponential Smoothing for Online Filtering of Pixel Prediction Maps](https://openaccess.thecvf.com/content_iccv_2015/papers/Dang_Adaptive_Exponential_Smoothing_ICCV_2015_paper.pdf), [Temporal Video Segmentation: A Survey](https://www.ee.columbia.edu/~sfchang/course/vis/REF/temporal-video-segmentation-a.pdf).

## 4. Recommended plan, in order

### Phase 1 — pipeline logic only, no retraining (do this first)

All three land in `_sample_and_classify()` in `video_pipeline.py`, and are cheap, safe, and reversible:

1. **Hysteresis / confirm-before-switching.** Don't commit a class change on the first differing frame. Require the candidate class to be the CNN's top pick for K consecutive sampled frames (try K=2–3 at 2fps, i.e. 1–1.5s of agreement) before it becomes the new `current_class`. This alone should kill most of the 325 GameWorkspace↔ProductPlacement flips, since real product-placement moments last several seconds in your correction, not one frame.
2. **Minimum confidence to switch.** Only accept a transition if `final_confidence` clears a threshold (e.g. 0.65). Below that, keep the current class instead of switching — directly targets the ~0.57–0.60 average confidence flip-flopping you're seeing.
3. **Post-hoc short-segment merge.** After scene-building, run a despike pass: any scene under ~2–3s gets absorbed into a neighboring scene (prefer merging into the class that appears on both sides, i.e. collapse `A(long) → B(1s) → A(long)` into one `A` scene unless `B` is itself a class that's expected to be brief and meaningful, like a quick `ProductSelection` click).

### Phase 2 — probability-level smoothing (moderate effort)

4. Keep a running EMA of the CNN's softmax vector across frames (not just the label) and base the transition check on the smoothed vector's argmax/confidence, rather than the raw per-frame vector. This is a small, local change to `_sample_and_classify()`'s loop state and composes naturally with Phase 1's hysteresis.

### Phase 3 — best long-term accuracy (bigger effort)

5. **HMM/Viterbi smoothing** as a second pass over a whole video's per-frame probability sequence, with a transition penalty tuned against a few manually-corrected videos like this one. This is the "proper" fix used in the literature above, but it's more implementation work (needs the raw per-frame probability sequence retained, not just committed scenes) — worth doing once Phase 1/2 prove the concept.
6. **Targeted data fix for the confused pair.** Since `GameWorkspace`/`ProductPlacement` confusion is partly a real visual-similarity problem, add more labeled training images specifically around placement moments (ideally capturing the cursor/ghost-icon state) so the CNN itself is more confident on this boundary — smoothing reduces the *symptom* in the log, better training data reduces the *cause*.
7. **Let the existing OCR-exclusion mechanism do its job.** `training_pipeline.py` already auto-computes `fusion_alpha_per_class`, excluding OCR entirely for a class when its OCR-only F1 is far below its CNN-only F1 (same mechanism already active for `Bulldozing`, visible as `cnn_per_class_override` in your CSV). If a retrain shows OCR text doesn't reliably separate `GameWorkspace`/`ProductPlacement` either (plausible — 36% of your log came from the fusion path at fairly low confidence), retraining should route both to CNN-only automatically, removing OCR as a noise source for this pair without any pipeline code changes.

## 5. Suggested next step

I'd implement Phase 1 first — it's a self-contained change to one function, doesn't touch training or the model at all, and is easy to test directly against this same video to compare before/after segment counts. If you want, I can make that change now and you can re-run this video to see the difference before we decide whether Phase 2/3 are worth the extra effort.

## 6. Phase 1 results, and a tuning pass

Phase 1 was implemented and re-tested against this same video. The flicker problem it targeted is fixed:

| | Before Phase 1 | After Phase 1 | Ground truth |
|---|---|---|---|
| Scenes | 429 | 95 | 100 |
| Median scene length | 1s | 7s | ~9s |
| GameWorkspace↔ProductPlacement flips | 325 (76% of transitions) | 17 (18%) | — |

But the comparison also surfaced two side effects, not bugs in the logic itself:

- **ProductPlacement got under-detected** (dropped to ~5% of the video vs. its true ~18% share). Requiring `HYSTERESIS_FRAMES=3` consecutive frames AND `MIN_SWITCH_CONFIDENCE=0.6` was too strict for real events that are themselves brief (ground truth ProductPlacement scenes average ~9s) — not just for noise.
- **A genuine CNN confusion (GameWorkspace vs. Bulldozing) got MORE visible**, not less: Bulldozing jumped to 28.8% of the video vs. its true 2.3%. Hysteresis makes the pipeline "sticky" on purpose — once a candidate is confirmed, it holds. That's exactly what kills flicker, but it also means any *systematic* (non-random) CNN bias toward a wrong class over a stretch of frames now consolidates into one large wrong block instead of staying fragmented as scattered, low-impact noise the way it did before Phase 1. This is a real model/data problem (see Phase 3, item 6) — no amount of hysteresis/confidence tuning fixes it, since tuning only changes how easily a stable signal gets through, not what the CNN's raw signal actually is.

**Tuning pass applied:** `HYSTERESIS_FRAMES` 3→2 and `MIN_SWITCH_CONFIDENCE` 0.6→0.5, to recover more real brief events like ProductPlacement without fully reopening the door to single-frame flicker. This does NOT address the Bulldozing/GameWorkspace confusion — that still needs Phase 3, item 6 (more/better training data for those two classes) to actually fix. Worth reprocessing this video again after the tuning pass to see the effect on ProductPlacement specifically, and to confirm Bulldozing is unchanged (expected, since it's not a hysteresis-strictness problem).

## 7. Tuning pass results — pipeline tuning has hit its ceiling

Re-tested against the same video a third time:

| | v2 (hyst=3, conf=0.6) | v3 (hyst=2, conf=0.5) | Ground truth |
|---|---|---|---|
| ProductPlacement share | 4.6% | 6.0% | 17.9% |
| Bulldozing share | 28.8% | 28.8% | 2.3% |
| GameWorkspace↔ProductPlacement flips | 17 | 13 | — |

ProductPlacement moved a little (still far short). **Bulldozing didn't move at all — 548s to 549s, functionally unchanged.** That's the clearest possible proof this isn't a threshold-strictness problem: Bulldozing's confidence readings in the log are mostly 0.7–0.95, comfortably above both the old and new confidence floor, so lowering the floor further can't touch it. The CNN itself is confidently, systematically calling long GameWorkspace stretches "Bulldozing" in the back half of this video — hysteresis and confidence floors only gate how a signal gets *through* the pipeline, they can't change what the signal *is*.

One more honest data point: measuring total absolute deviation from the ground truth's class-time distribution, Phase 1 actually made that specific number slightly *worse* (46.0 → 53.1 percentage-points of total error), entirely because of Bulldozing consolidating into large confident blocks instead of staying fragmented as scattered noise. The log is far more readable now (95 sane scenes vs. 429 flickering ones) and the flicker problem is genuinely solved — but class-attribution accuracy hasn't net-improved yet, and won't from further pipeline tuning. The critical path from here is training-data work on Bulldozing/GameWorkspace, not more constant-tuning.

**Recommended next steps, in order:**
1. **Check for a free win first:** does the game show any on-screen text/UI label specifically while a bulldoze/demolish action or tool is active (a tool name, a mode banner, a cost/confirm prompt) that ISN'T present during plain idle GameWorkspace? If so, a keyword rule (`PATCH /models/{id}/keyword-rules`, already built, no retraining needed) could route those frames correctly almost for free.
2. **Add more/better training images for `Bulldozing` and `GameWorkspace`**, specifically pulled from the ~19:30–31:46 stretch of this video (or similar sessions) where the confusion is concentrated — not just more images in general, but images covering whatever visual state the current training set is missing there.
3. **Retrain and reprocess this same video again** to close the loop with the same before/after measurement.
4. Worth confirming whether "bulldozing" is a brief *action/animation* rather than a sustained *visual state* — if the only real visual difference is a short animation playing for 1-2 seconds, a single-frame classifier has a hard ceiling no matter how much data it gets, and that would point toward a different technique (e.g. motion/frame-difference detection) rather than more screenshots.
