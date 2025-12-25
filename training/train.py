#!/usr/bin/env python3
"""
Luddo AI Fine-Tuning Script

Uses MLX for efficient LoRA fine-tuning on Apple Silicon.
Trains on JSONL datasets generated from simulations.
"""

import argparse
import json
import os
import sys
from pathlib import Path
from datetime import datetime
import subprocess
import shutil

def write_progress(progress_file: str, data: dict):
    """Write progress to file for Node.js to read"""
    with open(progress_file, 'w') as f:
        json.dump(data, f)

def check_mlx_installed():
    """Check if MLX-LM is installed"""
    try:
        import mlx_lm
        return True
    except ImportError:
        return False

def install_mlx():
    """Install MLX-LM"""
    subprocess.run([sys.executable, '-m', 'pip', 'install', 'mlx-lm', '-q'], check=True)

def convert_jsonl_to_mlx_format(input_path: str, output_dir: str) -> int:
    """Convert JSONL dataset to MLX format"""
    examples = []
    with open(input_path, 'r') as f:
        for line in f:
            if line.strip():
                data = json.loads(line)
                messages = data.get('messages', [])
                # Format as text for MLX
                text = ""
                for msg in messages:
                    role = msg.get('role', 'user')
                    content = msg.get('content', '')
                    if role == 'system':
                        text += f"<|system|>\n{content}\n"
                    elif role == 'user':
                        text += f"<|user|>\n{content}\n"
                    elif role == 'assistant':
                        text += f"<|assistant|>\n{content}\n"
                examples.append({"text": text})

    # Split into train/valid
    split_idx = max(1, int(len(examples) * 0.9))
    train_data = examples[:split_idx]
    valid_data = examples[split_idx:] if split_idx < len(examples) else examples[-1:]

    # Write files
    os.makedirs(output_dir, exist_ok=True)
    with open(os.path.join(output_dir, 'train.jsonl'), 'w') as f:
        for ex in train_data:
            f.write(json.dumps(ex) + '\n')

    with open(os.path.join(output_dir, 'valid.jsonl'), 'w') as f:
        for ex in valid_data:
            f.write(json.dumps(ex) + '\n')

    return len(examples)

def load_checkpoint(checkpoint_file: str) -> dict:
    """Load checkpoint state if exists"""
    if os.path.exists(checkpoint_file):
        with open(checkpoint_file, 'r') as f:
            return json.load(f)
    return None

def save_checkpoint(checkpoint_file: str, data: dict):
    """Save checkpoint state"""
    with open(checkpoint_file, 'w') as f:
        json.dump(data, f)

def main():
    parser = argparse.ArgumentParser(description='Fine-tune Luddo AI model')
    parser.add_argument('--base-model', help='Base model name (e.g., llama3.2:3b)')
    parser.add_argument('--dataset', help='Path to JSONL dataset')
    parser.add_argument('--output', help='Output model name')
    parser.add_argument('--epochs', type=int, default=3, help='Number of training epochs')
    parser.add_argument('--progress-file', help='File to write progress updates')
    parser.add_argument('--output-dir', help='Directory for output model')
    parser.add_argument('--resume', action='store_true', help='Resume from checkpoint if available')
    parser.add_argument('--config', help='Path to JSON config file (overrides other args)')
    args = parser.parse_args()

    # Load config from file if provided (for PM2 process management)
    if args.config:
        with open(args.config, 'r') as f:
            config = json.load(f)
        args.base_model = config.get('baseModel', args.base_model)
        args.dataset = config.get('dataset', args.dataset)
        args.output = config.get('output', args.output)
        args.epochs = config.get('epochs', args.epochs)
        args.progress_file = config.get('progressFile', args.progress_file)
        args.output_dir = config.get('outputDir', args.output_dir)
        args.resume = config.get('resume', args.resume)

    # Validate required arguments
    if not all([args.base_model, args.dataset, args.output, args.progress_file, args.output_dir]):
        parser.error('Missing required arguments. Either use --config or provide all required args.')

    progress_file = args.progress_file

    try:
        # Initial progress
        write_progress(progress_file, {
            'stage': 'initializing',
            'progress': 0,
            'message': 'Checking dependencies...',
            'epoch': 0,
            'total_epochs': args.epochs,
            'loss': None,
            'learning_rate': None
        })

        # Check/install MLX
        if not check_mlx_installed():
            write_progress(progress_file, {
                'stage': 'installing',
                'progress': 2,
                'message': 'Installing MLX-LM...',
                'epoch': 0,
                'total_epochs': args.epochs,
                'loss': None,
                'learning_rate': None
            })
            install_mlx()

        import mlx_lm
        from mlx_lm import lora, generate

        write_progress(progress_file, {
            'stage': 'loading_model',
            'progress': 5,
            'message': f'Setting up for model: {args.base_model}...',
            'epoch': 0,
            'total_epochs': args.epochs,
            'loss': None,
            'learning_rate': None
        })

        # Map Ollama model names to HuggingFace MLX models
        model_mapping = {
            'llama3.2:3b': 'mlx-community/Llama-3.2-3B-Instruct-4bit',
            'llama3.2:1b': 'mlx-community/Llama-3.2-1B-Instruct-4bit',
            'llama3.1:8b': 'mlx-community/Meta-Llama-3.1-8B-Instruct-4bit',
            'mistral:7b': 'mlx-community/Mistral-7B-Instruct-v0.3-4bit',
            'qwen2.5:3b': 'mlx-community/Qwen2.5-3B-Instruct-4bit',
            'qwen2.5:7b': 'mlx-community/Qwen2.5-7B-Instruct-4bit',
        }

        # Custom models map to their base models
        # These are fine-tuned variants that should use the same HF model for continued training
        custom_model_bases = {
            'luddo-expert': 'llama3.2:3b',
            'luddo-expert:latest': 'llama3.2:3b',
            'llama3.2-luddo-finetuned': 'llama3.2:3b',
        }

        # Resolve custom models to their base
        resolved_model = args.base_model
        if args.base_model in custom_model_bases:
            resolved_model = custom_model_bases[args.base_model]
            print(f"Custom model '{args.base_model}' resolved to base model '{resolved_model}'")

        hf_model = model_mapping.get(resolved_model)
        if not hf_model:
            # Check if it's a custom model variant (contains 'luddo' or 'expert')
            base_lower = args.base_model.lower()
            if 'luddo' in base_lower or 'expert' in base_lower or 'finetuned' in base_lower:
                # Default to llama3.2:3b for any luddo custom models
                hf_model = model_mapping['llama3.2:3b']
                print(f"Custom model detected, using base: {hf_model}")
            else:
                # Try to use MLX community variant for unknown models
                base_name = resolved_model.replace(':', '-').title()
                hf_model = f'mlx-community/{base_name}-4bit'

        write_progress(progress_file, {
            'stage': 'preparing_data',
            'progress': 10,
            'message': 'Preparing training data...',
            'epoch': 0,
            'total_epochs': args.epochs,
            'loss': None,
            'learning_rate': None
        })

        # Prepare output directory
        output_path = Path(args.output_dir) / args.output
        output_path.mkdir(parents=True, exist_ok=True)

        # Checkpoint file path
        checkpoint_file = str(output_path / 'checkpoint.json')
        adapter_path = str(output_path / 'adapters')

        # Check for resume
        resume_from_iter = 0
        loss_history = []
        if args.resume:
            checkpoint = load_checkpoint(checkpoint_file)
            if checkpoint:
                resume_from_iter = checkpoint.get('last_iter', 0)
                loss_history = checkpoint.get('loss_history', [])
                print(f"Resuming from iteration {resume_from_iter}")
                write_progress(progress_file, {
                    'stage': 'resuming',
                    'progress': 5,
                    'message': f'Resuming training from iteration {resume_from_iter}...',
                    'epoch': checkpoint.get('epoch', 1),
                    'total_epochs': args.epochs,
                    'loss': checkpoint.get('last_loss'),
                    'learning_rate': 1e-5,
                    'loss_history': loss_history[-50:]
                })

        # Convert dataset to MLX format
        data_dir = str(output_path / 'data')
        dataset_size = convert_jsonl_to_mlx_format(args.dataset, data_dir)

        write_progress(progress_file, {
            'stage': 'starting_training',
            'progress': 15,
            'message': f'Starting LoRA training on {dataset_size} examples...',
            'epoch': 0,
            'total_epochs': args.epochs,
            'loss': None,
            'learning_rate': None,
            'dataset_size': dataset_size
        })

        # Calculate iterations based on epochs
        # Assuming batch size of 4, we get iterations per epoch
        iters_per_epoch = max(1, dataset_size // 4)
        total_iters = iters_per_epoch * args.epochs

        # Train using MLX-LM LoRA
        # We'll use subprocess to call mlx_lm.lora which gives us progress output
        # adapter_path already defined above for checkpoint support

        # Create training config
        train_config = {
            'model': hf_model,
            'data': data_dir,
            'train': True,
            'iters': total_iters,
            'batch_size': 4,
            'num_layers': 16,  # Updated from lora_layers for new mlx_lm API
            'learning_rate': 1e-5,
            'adapter_path': adapter_path,
        }

        # Run training with progress monitoring
        loss_history = []
        current_epoch = 0

        # Use mlx_lm.lora directly
        try:
            from mlx_lm.tuner.trainer import TrainingArgs, train
            from mlx_lm.tuner.lora import LoRALinear
            import mlx.core as mx

            # Load model and tokenizer
            write_progress(progress_file, {
                'stage': 'loading_model',
                'progress': 20,
                'message': f'Loading {hf_model}...',
                'epoch': 0,
                'total_epochs': args.epochs,
                'loss': None,
                'learning_rate': None,
                'dataset_size': dataset_size
            })

            model, tokenizer = mlx_lm.load(hf_model)

            # Apply LoRA
            write_progress(progress_file, {
                'stage': 'applying_lora',
                'progress': 25,
                'message': 'Applying LoRA adapters...',
                'epoch': 0,
                'total_epochs': args.epochs,
                'loss': None,
                'learning_rate': None,
                'dataset_size': dataset_size
            })

            # Training arguments
            training_args = TrainingArgs(
                batch_size=4,
                iters=total_iters,
                val_batches=5,
                steps_per_report=10,
                steps_per_eval=50,
                save_every=100,
                adapter_path=adapter_path,
                max_seq_length=512,  # Reduced from 1024 - training examples are ~200 tokens
                learning_rate=1e-5,
            )

            # Custom callback for progress
            class ProgressCallback:
                def __init__(self, progress_file, total_iters, epochs, dataset_size):
                    self.progress_file = progress_file
                    self.total_iters = total_iters
                    self.epochs = epochs
                    self.dataset_size = dataset_size
                    self.loss_history = []
                    self.iters_per_epoch = total_iters // epochs

                def __call__(self, iteration, train_loss, val_loss, learning_rate):
                    current_epoch = min(self.epochs, iteration // self.iters_per_epoch + 1)
                    progress = 25 + int((iteration / self.total_iters) * 70)

                    self.loss_history.append({
                        'step': iteration,
                        'loss': float(train_loss),
                        'epoch': current_epoch
                    })

                    write_progress(self.progress_file, {
                        'stage': 'training',
                        'progress': min(progress, 95),
                        'message': f'Training epoch {current_epoch}/{self.epochs}',
                        'epoch': current_epoch,
                        'total_epochs': self.epochs,
                        'loss': float(train_loss),
                        'learning_rate': float(learning_rate) if learning_rate else None,
                        'dataset_size': self.dataset_size,
                        'step': iteration,
                        'total_steps': self.total_iters,
                        'loss_history': self.loss_history[-50:]
                    })

            # Note: MLX-LM train doesn't have callback support directly
            # We'll use the CLI approach with output parsing instead

        except Exception as e:
            print(f"Direct training failed: {e}, using CLI approach")

        # Fallback: Use CLI approach with subprocess
        write_progress(progress_file, {
            'stage': 'training',
            'progress': 30,
            'message': 'Training with MLX LoRA...',
            'epoch': 1,
            'total_epochs': args.epochs,
            'loss': None,
            'learning_rate': None,
            'dataset_size': dataset_size
        })

        # Run mlx_lm lora via CLI (new API format)
        # Calculate remaining iterations if resuming
        remaining_iters = total_iters - resume_from_iter
        if remaining_iters <= 0:
            print(f"Training already complete (iter {resume_from_iter} >= {total_iters})")
            # Skip to post-training steps
        else:
            cmd = [
                sys.executable, '-m', 'mlx_lm', 'lora',
                '--model', hf_model,
                '--data', data_dir,
                '--train',
                '--iters', str(remaining_iters),
                '--batch-size', '4',
                '--num-layers', '16',
                '--learning-rate', '1e-5',
                '--steps-per-report', '1',  # Report every step for real-time updates
                '--adapter-path', adapter_path,
            ]

            # If resuming from existing adapters, add resume flag
            if resume_from_iter > 0 and os.path.exists(adapter_path):
                cmd.append('--resume-adapter-file')
                cmd.append(os.path.join(adapter_path, 'adapters.safetensors'))

            process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1
            )

            current_iter = resume_from_iter  # Start from checkpoint

            for line in process.stdout:
                print(line.strip())  # Log to stdout

                # Parse training output for progress
                if 'Iter' in line and 'Train loss' in line:
                    try:
                        # Parse line like "Iter 350: Train loss 0.158, Learning Rate 1.000e-05, ..."
                        parts = line.split(',')
                        iter_loss_part = parts[0]  # "Iter 350: Train loss 0.158"

                        # Extract iteration number (relative to this run)
                        iter_match = iter_loss_part.split(':')[0]  # "Iter 350"
                        relative_iter = int(iter_match.split()[1])
                        # Add resume offset to get absolute iteration
                        current_iter = resume_from_iter + relative_iter

                        # Extract train loss (after "Train loss")
                        if 'Train loss' in iter_loss_part:
                            loss_str = iter_loss_part.split('Train loss')[1].strip()
                            train_loss = float(loss_str)
                        else:
                            train_loss = None

                        if train_loss:
                            current_epoch = min(args.epochs, current_iter // iters_per_epoch + 1)
                            progress = 30 + int((current_iter / total_iters) * 65)

                            loss_history.append({
                                'step': current_iter,
                                'loss': train_loss,
                                'epoch': current_epoch
                            })

                            write_progress(progress_file, {
                                'stage': 'training',
                                'progress': min(progress, 95),
                                'message': f'Training epoch {current_epoch}/{args.epochs}',
                                'epoch': current_epoch,
                                'total_epochs': args.epochs,
                                'loss': train_loss,
                                'learning_rate': 1e-5,
                                'dataset_size': dataset_size,
                                'step': current_iter,
                                'total_steps': total_iters,
                                'loss_history': loss_history[-50:]
                            })

                            # Save checkpoint every 100 iterations
                            if current_iter % 100 == 0:
                                save_checkpoint(checkpoint_file, {
                                    'last_iter': current_iter,
                                    'last_loss': train_loss,
                                    'epoch': current_epoch,
                                    'loss_history': loss_history[-100:],
                                    'total_iters': total_iters,
                                    'dataset_size': dataset_size
                                })
                    except Exception as parse_error:
                        pass  # Ignore parse errors

            process.wait()

            if process.returncode != 0:
                raise Exception(f"Training failed with exit code {process.returncode}")

        write_progress(progress_file, {
            'stage': 'fusing_model',
            'progress': 96,
            'message': 'Fusing adapters with base model...',
            'epoch': args.epochs,
            'total_epochs': args.epochs,
            'loss': loss_history[-1]['loss'] if loss_history else None,
            'learning_rate': None,
            'dataset_size': dataset_size,
            'loss_history': loss_history
        })

        # Fuse LoRA adapters with base model (with dequantization for GGUF conversion)
        fused_path = str(output_path / 'fused')
        fuse_cmd = [
            sys.executable, '-m', 'mlx_lm', 'fuse',
            '--model', hf_model,
            '--adapter-path', adapter_path,
            '--save-path', fused_path,
            '--dequantize',  # Required for GGUF conversion
        ]
        subprocess.run(fuse_cmd, check=True)

        write_progress(progress_file, {
            'stage': 'converting_gguf',
            'progress': 97,
            'message': 'Converting model to GGUF format...',
            'epoch': args.epochs,
            'total_epochs': args.epochs,
            'loss': loss_history[-1]['loss'] if loss_history else None,
            'learning_rate': None,
            'dataset_size': dataset_size,
            'loss_history': loss_history
        })

        # Convert to single-file safetensors (required for llama.cpp conversion)
        single_path = str(output_path / 'fused-single')
        gguf_path = str(output_path / f'{args.output}.gguf')

        try:
            import torch
            from transformers import AutoModelForCausalLM, AutoTokenizer

            print("Loading fused model for GGUF conversion...")
            model = AutoModelForCausalLM.from_pretrained(fused_path, torch_dtype=torch.float16)
            tokenizer = AutoTokenizer.from_pretrained(fused_path)

            print("Saving as single file...")
            os.makedirs(single_path, exist_ok=True)
            model.save_pretrained(single_path, max_shard_size="100GB")
            tokenizer.save_pretrained(single_path)

            # Convert to GGUF using llama.cpp
            llama_cpp_path = "/Volumes/AI_SSD/ai-local/llama.cpp"
            convert_script = os.path.join(llama_cpp_path, "convert_hf_to_gguf.py")

            if os.path.exists(convert_script):
                print("Converting to GGUF format...")
                convert_result = subprocess.run([
                    sys.executable, convert_script,
                    '--outtype', 'f16',
                    '--outfile', gguf_path,
                    single_path
                ], capture_output=True, text=True)

                if convert_result.returncode != 0:
                    print(f"GGUF conversion warning: {convert_result.stderr}")
                    gguf_path = None
            else:
                print(f"llama.cpp convert script not found at {convert_script}")
                gguf_path = None

        except Exception as e:
            print(f"GGUF conversion failed: {e}")
            gguf_path = None

        write_progress(progress_file, {
            'stage': 'importing_ollama',
            'progress': 99,
            'message': 'Importing model to Ollama...',
            'epoch': args.epochs,
            'total_epochs': args.epochs,
            'loss': loss_history[-1]['loss'] if loss_history else None,
            'learning_rate': None,
            'dataset_size': dataset_size,
            'loss_history': loss_history
        })

        # Create Ollama Modelfile - prefer GGUF if available
        model_source = gguf_path if gguf_path and os.path.exists(gguf_path) else fused_path
        modelfile_content = f'''FROM {model_source}

SYSTEM """You are an expert Luddo game AI, fine-tuned with LoRA on winning game decisions.

RULES:
- Roll 6 to exit yard, capture or reach home = bonus turn
- Safe spots: Start (0,13,26,39) and Stars (8,21,34,47)
- 56 steps to home (51-55 = home stretch)

PRIORITIES: Capture > Escape threat > Home stretch > Advance

Respond: TOKEN: [0-3] and REASONING: [explanation]"""

PARAMETER temperature 0.5
PARAMETER num_ctx 4096
'''

        modelfile_path = str(output_path / 'Modelfile')
        with open(modelfile_path, 'w') as f:
            f.write(modelfile_content)

        # Import to Ollama
        ollama_env = os.environ.copy()
        ollama_env['OLLAMA_MODELS'] = '/Volumes/AI_SSD/ai-local/ollama/models'

        result = subprocess.run(
            ['ollama', 'create', args.output, '-f', modelfile_path],
            capture_output=True,
            text=True,
            env=ollama_env
        )

        if result.returncode != 0:
            print(f"Warning: Ollama import may have issues: {result.stderr}")

        # Final success
        final_loss = loss_history[-1]['loss'] if loss_history else None

        write_progress(progress_file, {
            'stage': 'completed',
            'progress': 100,
            'message': f'Training complete! Model: {args.output}',
            'epoch': args.epochs,
            'total_epochs': args.epochs,
            'loss': final_loss,
            'final_loss': final_loss,
            'learning_rate': None,
            'dataset_size': dataset_size,
            'loss_history': loss_history,
            'model_path': fused_path,
            'ollama_model': args.output
        })

        print(f"Successfully trained and imported model: {args.output}")
        sys.exit(0)

    except Exception as e:
        import traceback
        error_msg = f"{str(e)}\n{traceback.format_exc()}"
        write_progress(progress_file, {
            'stage': 'failed',
            'progress': 0,
            'message': f'Training failed: {str(e)}',
            'error': error_msg,
            'epoch': 0,
            'total_epochs': args.epochs,
            'loss': None,
            'learning_rate': None
        })
        print(f"Error: {error_msg}", file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()
