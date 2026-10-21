# Third-party notices

Xayra's original source code is proprietary (see `LICENSE`); no ownership of
the third-party material below is claimed. This file lists
third-party material that is in this repository, or that Xayra depends on,
and the licence each is under. Each item stays under its own licence.

## 1. Material in this repository

### Expo project template — MIT License

The project was created from the Expo project template. Template-derived
material still in the repository:

- `AGENTS.md` (template text)
- the starting structure of `tsconfig.json`, `package.json` and `.gitignore`
  (since substantially rewritten)

```
The MIT License (MIT)

Copyright (c) 2015-present 650 Industries, Inc. (aka Expo)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Fonts — SIL Open Font License 1.1

| Font | Files | Copyright | Licence text |
|---|---|---|---|
| DM Sans | `assets/fonts/dmsans_*.ttf` | Copyright 2014 The DM Sans Project Authors | `assets/fonts/DMSans-OFL.txt` |
| Plus Jakarta Sans | `assets/fonts/plusjakartasans_*.ttf` | Copyright 2020 The Plus Jakarta Sans Project Authors | `assets/fonts/PlusJakartaSans-OFL.txt` |

### Patches to third-party packages — MIT License

The files in `patches/` modify the packages below and contain excerpts of
their source. Those excerpts remain under the package's licence.

| Patch | Package | Copyright |
|---|---|---|
| `patches/whisper.rn+0.7.2.patch` | whisper.rn 0.7.2 | Copyright (c) 2023 Jhen-Jie Hong |
| `patches/onnxruntime-react-native+1.24.3.patch` | onnxruntime-react-native 1.24.3 | Copyright (c) Microsoft Corporation |
| `patches/@fugood+react-native-audio-pcm-stream+1.1.4.patch` | @fugood/react-native-audio-pcm-stream 1.1.4 | Copyright (c) 2020 Qi Xi |

The MIT License text above (with each package's own copyright line) applies.

### Reproduced formula

`components/useExpandOverdragGestureHandlers.ts` reproduces the snap
projection formula from `@gorhom/bottom-sheet` (MIT, Copyright (c) 2020
Mo Gorhom).

## 2. Dependencies installed by npm (not stored in this repository)

The packages in `package.json` / `package-lock.json` are installed by npm
under their own licences. They are not copied into this repository.

## 3. AI models downloaded by the app (not stored in this repository)

| Model | Licence |
|---|---|
| Whisper `tiny.en` / `base.en` (OpenAI), GGML format from whisper.cpp | MIT |
| bge-small-en-v1.5 (BAAI), quantized ONNX | MIT |
| Qwen2.5-1.5B-Instruct (Alibaba Cloud / Qwen team), fine-tuned by the Xayra developer for to-do extraction and answers | Apache License 2.0 |

The fine-tuned model is a modified version of Qwen2.5-1.5B-Instruct. The
modification notice and licence texts are in
[`licenses/MODEL_NOTICE.md`](licenses/MODEL_NOTICE.md) and
[`licenses/Qwen2.5-1.5B-Instruct-LICENSE.txt`](licenses/Qwen2.5-1.5B-Instruct-LICENSE.txt)
(the Qwen repository's own Apache License 2.0 file, unchanged).
