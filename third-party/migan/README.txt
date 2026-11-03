Local logo-area repair uses the MI-GAN image inpainting model (CPU inference).

Research and code: https://github.com/Picsart-AI-Research/MI-GAN
MI-GAN: A Simple Baseline for Image Inpainting on Mobile Devices, ICCV 2023.
Copyright (c) 2023 Picsart AI Research. MIT License (LICENSE.txt).

Preconverted pipeline: https://huggingface.co/andraniksargsyan/migan
File: migan_pipeline_v2.onnx
Revision: 406830d0fa60666da0071c342ad2fbc8f30c5c64
SHA256: 6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b
Bytes: 28079181
Model license: MIT (LICENSE-WEIGHTS.txt).

The bundled model runs offline using Microsoft's onnxruntime-node CPU runtime.
Runtime telemetry is disabled before initialization. No repair service, API key
or additional download is required. Only masked pixels (plus a 3-pixel border)
are replaced; the original image dimensions and pixels outside that area stay
unchanged. Reconstructed texture is an estimate and requires visual review.
