"""Package init — deliberately not empty.

The env var below MUST be set before TensorFlow is imported anywhere in
this process, and this file is the earliest point that's guaranteed to run:
every entry point into the sidecar (`run.py` -> `app.main`, or `uvicorn
app.main:app` directly, or a test importing `app.db`) imports the `app`
package first, so this executes before any module that could pull in
TensorFlow — app/ml/classifier.py via `tf_keras`, or
app/training_pipeline.py via its lazy `import tensorflow`.

Why it's needed (the cloud backend hit the identical bug — see
backend/app/worker.py, which fixes it the same way):

TensorFlow >= 2.16 bundles Keras 3 and makes `tf.keras` an alias for it.
app/training_pipeline.py builds and saves models through plain `tf.keras.*`,
so without this env var those saves land in Keras 3's H5 format, whose
InputLayer config uses a `batch_shape` key. But app/ml/classifier.py
deliberately LOADS models through the separate `tf_keras` package (legacy
Keras 2, kept for compatibility with the bundled Teachable Machine export),
and Keras 2's InputLayer doesn't recognize `batch_shape` at all — it expects
`batch_input_shape`. The result: training succeeded, then every video job
using that model died with

    Error when deserializing class 'InputLayer' using
    config={'batch_shape': [None, 224, 224, 3], ...}
    Unrecognized keyword arguments: ['batch_shape']

Setting this before tensorflow's own `__init__.py` runs (which is where the
decision gets made and cached) routes `tf.keras` to legacy Keras 2, so what
training saves is exactly what the loader can read.

`setdefault`, not a plain assignment, so it stays overridable from the
environment if you ever deliberately want Keras 3.
"""
import os

os.environ.setdefault("TF_USE_LEGACY_KERAS", "1")

# TensorFlow's C++ layer logs a wall of INFO/WARNING noise to stderr on
# import (CPU instruction sets, oneDNN notices). The Flutter app pipes the
# sidecar's stderr straight to its own console (see
# lib/services/sidecar_service.dart), so quieting this keeps real errors
# visible instead of buried. 2 = errors only.
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
