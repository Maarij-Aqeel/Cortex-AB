# Third-party notices

This repository's own code is MIT-licensed (see [LICENSE](LICENSE)). It does
**not** include any model weights or datasets. The pieces below are downloaded
at build or run time, and each comes with its own terms. Running this project
means accepting them.

| Component | Used for | License / terms |
|---|---|---|
| [TRIBE v2](https://github.com/facebookresearch/tribev2) code and [weights](https://huggingface.co/facebook/tribev2) (Meta FAIR) | Brain-response prediction | **CC BY-NC 4.0, non-commercial use only** |
| [Llama 3.2 3B](https://huggingface.co/meta-llama/Llama-3.2-3B) | TRIBE's text encoder | Llama 3.2 Community License (gated; accept on Hugging Face) |
| [V-JEPA 2](https://huggingface.co/facebook/vjepa2-vitg-fpc64-256) | TRIBE's video encoder | See model card |
| [w2v-BERT 2.0](https://huggingface.co/facebook/w2v-bert-2.0) | TRIBE's audio encoder | See model card |
| [WhisperX](https://github.com/m-bain/whisperX) / [faster-whisper large-v3](https://huggingface.co/Systran/faster-whisper-large-v3) | Word-level transcription | See project and model card |
| [HCP-MMP1 parcellation](https://doi.org/10.1038/nature18933) (Glasser et al., 2016), files as distributed for MNE | Grouping cortex vertices into brain regions | Human Connectome Project data use terms |
| fsaverage5 surface (FreeSurfer, via [nilearn](https://nilearn.github.io)) | 3D cortex mesh | FreeSurfer license |
| [spaCy `en_core_web_lg`](https://spacy.io/models/en) | Sentence segmentation inside TRIBE's pipeline | MIT |

Because TRIBE v2 is licensed for non-commercial use, this project as a whole
should be treated as **non-commercial**: research, education and personal
experiments. Using it to score ads or content for a business needs a separate
agreement with Meta.
