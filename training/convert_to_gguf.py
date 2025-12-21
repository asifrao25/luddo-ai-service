#!/usr/bin/env python3
"""
Convert MLX fused model to GGUF format for Ollama
"""

import argparse
import subprocess
import sys
import os
from pathlib import Path
import shutil

def check_llama_cpp():
    """Check if llama.cpp conversion tools are available"""
    try:
        result = subprocess.run(
            ['python3', '-c', 'import llama_cpp; print(llama_cpp.__file__)'],
            capture_output=True, text=True
        )
        return result.returncode == 0
    except:
        return False

def install_conversion_deps():
    """Install required dependencies for conversion"""
    print("Installing conversion dependencies...")
    subprocess.run([sys.executable, '-m', 'pip', 'install',
                   'transformers', 'torch', 'sentencepiece', 'protobuf', '-q'], check=True)

def convert_mlx_to_hf(mlx_path: str, hf_path: str):
    """Convert MLX model to HuggingFace format"""
    print(f"Converting MLX model to HuggingFace format...")

    # MLX fused models should already have HF-compatible files
    # We just need to ensure the format is correct
    src = Path(mlx_path)
    dst = Path(hf_path)

    if dst.exists():
        shutil.rmtree(dst)

    # Copy all files
    shutil.copytree(src, dst)

    # The config.json and tokenizer files should be compatible
    return True

def convert_hf_to_gguf(hf_path: str, gguf_path: str, model_name: str):
    """Convert HuggingFace model to GGUF using llama.cpp"""
    print(f"Converting to GGUF format...")

    # Try using the llama.cpp convert script
    # First, try to find or download the convert script
    convert_script = Path(__file__).parent / 'convert_hf_to_gguf.py'

    if not convert_script.exists():
        # Download the convert script from llama.cpp
        print("Downloading llama.cpp conversion script...")
        import urllib.request
        url = "https://raw.githubusercontent.com/ggerganov/llama.cpp/master/convert_hf_to_gguf.py"
        urllib.request.urlretrieve(url, convert_script)

    # Run conversion
    cmd = [
        sys.executable, str(convert_script),
        hf_path,
        '--outfile', gguf_path,
        '--outtype', 'q4_0'  # 4-bit quantization
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)

    if result.returncode != 0:
        print(f"GGUF conversion output: {result.stdout}")
        print(f"GGUF conversion errors: {result.stderr}")
        raise Exception(f"GGUF conversion failed: {result.stderr}")

    return True

def create_ollama_model(gguf_path: str, model_name: str):
    """Create Ollama model from GGUF file"""
    print(f"Creating Ollama model: {model_name}")

    modelfile_content = f'''FROM {gguf_path}

SYSTEM """You are an expert Luddo game AI trained on winning game strategies.
Analyze board positions and select optimal moves considering:
- Capture opportunities for bonus turns
- Safety from opponent captures
- Advancement toward home
- Token distribution strategy

Respond with TOKEN: [0-3] and REASONING: [brief explanation]"""

PARAMETER temperature 0.7
PARAMETER num_ctx 4096
'''

    modelfile_path = Path(gguf_path).parent / 'Modelfile.gguf'
    with open(modelfile_path, 'w') as f:
        f.write(modelfile_content)

    # Create in Ollama
    env = os.environ.copy()
    env['OLLAMA_MODELS'] = '/Volumes/AI_SSD/ai-local/ollama/models'

    result = subprocess.run(
        ['/opt/homebrew/bin/ollama', 'create', model_name, '-f', str(modelfile_path)],
        env=env, capture_output=True, text=True
    )

    if result.returncode != 0:
        print(f"Ollama create output: {result.stdout}")
        print(f"Ollama create errors: {result.stderr}")
        raise Exception(f"Ollama create failed: {result.stderr}")

    return True

def main():
    parser = argparse.ArgumentParser(description='Convert MLX model to Ollama GGUF')
    parser.add_argument('--mlx-path', required=True, help='Path to MLX fused model')
    parser.add_argument('--output-name', required=True, help='Output model name for Ollama')
    parser.add_argument('--work-dir', default='/tmp/luddo-convert', help='Working directory')
    args = parser.parse_args()

    work_dir = Path(args.work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)

    mlx_path = Path(args.mlx_path)
    hf_path = work_dir / 'hf_model'
    gguf_path = work_dir / f'{args.output_name}.gguf'

    try:
        # Install dependencies
        install_conversion_deps()

        # Step 1: MLX to HuggingFace (if needed)
        print("\n=== Step 1: Preparing HuggingFace format ===")
        convert_mlx_to_hf(str(mlx_path), str(hf_path))

        # Step 2: HuggingFace to GGUF
        print("\n=== Step 2: Converting to GGUF ===")
        convert_hf_to_gguf(str(hf_path), str(gguf_path), args.output_name)

        # Step 3: Create Ollama model
        print("\n=== Step 3: Creating Ollama model ===")
        create_ollama_model(str(gguf_path), args.output_name)

        print(f"\n=== SUCCESS ===")
        print(f"Model '{args.output_name}' is now available in Ollama!")

        # Cleanup
        if hf_path.exists():
            shutil.rmtree(hf_path)

    except Exception as e:
        print(f"\nERROR: {e}")
        sys.exit(1)

if __name__ == '__main__':
    main()
